import { NextResponse } from "next/server";
import { serverError } from "@/lib/api-errors";
import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { put } from "@vercel/blob";
import crypto from "crypto";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { readJsonDirect, deleteByPrefix, writeJsonReplacingPrefix } from "@/lib/blob-utils";
import { rpConfigFromRequest, hasChallengeSecret, verifyChallenge, mintAuthToken, isAdminIdentity } from "@/lib/auth-server";
import { LEGACY_RP_ID, passkeyNudgeUrgent, daysUntilPasskeySunset } from "@/lib/origin";
import { normaliseProfile } from "@/lib/profile-name";
import { credentialsPrefix, credentialsPath } from "@/lib/storage-keys";
import { acceptedConsentVersion } from "@/lib/consent";
import { indexSignIn, readCredentialSet, credentialMirrorDoc } from "@/lib/credential-store";
import { dbResolveHandle } from "@/lib/identity-store";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// Verify WebAuthn authentication and mint a short-lived auth token.
// POST /api/auth/login-verify
// Body: { profile, credential: { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle } }, consent?: { version }, quiet?: true }
//
// The assertion signature is now REALLY verified against the stored public key
// (over authenticatorData ‖ SHA-256(clientDataJSON)), along with the challenge,
// origin, rpId, and user-presence/verification flags. Only then is a token
// minted. Previously the route checked the challenge and that the credential id
// existed, then trusted the browser — but login-options hands the credential id
// to any caller, so the token was forgeable by anyone who knew a profile name.
// That token is the sole gate on destructive DELETE, so the padlock was
// decorative. It isn't anymore.
// consent (optional): the existing-holder confirm — stamped on the credentials
// doc only after the assertion verifies, riding the counter write, whose sweep
// deletes every older blob under the credentials prefix.
// quiet (optional, exactly true): a trainer or share ceremony, often on a
// shared laptop. The passkey is verified and the ceremony token returned as
// usual, but no photo or sync token is minted and no cookie is set.

const normalise = normaliseProfile;

export async function POST(request) {
  const limited = rateLimit(request, "auth-login", 20) || await rateLimitShared(request, "auth-login", 20);
  if (limited) return limited;
  try {
    const { profile, credential, consent, quiet: quietBody } = await request.json();
    const quiet = quietBody === true;
    if (!profile || !credential) {
      return NextResponse.json({ error: "Missing profile or credential" }, { status: 400 });
    }

    // Challenge validation. Stateless (signed) when CHALLENGE_SECRET is set —
    // no blob round-trip, so the "No pending authentication" race is gone;
    // otherwise validate the stored challenge blob (fallback). See auth-server.
    const stateless = hasChallengeSecret();
    const userId = crypto.createHash("sha256").update(normalise(profile)).digest("base64url");
    const challengeKey = `forge/challenges/${userId}`;
    let expectedChallenge;
    if (stateless) {
      expectedChallenge = (c) => verifyChallenge(c, profile, "auth");
    } else {
      const challengeData = await readJsonDirect(challengeKey);
      if (!challengeData) {
        return NextResponse.json({ error: "No pending authentication" }, { status: 400 });
      }
      if (Date.now() > challengeData.expires) {
        return NextResponse.json({ error: "Authentication expired" }, { status: 400 });
      }
      if (challengeData.profile !== normalise(profile)) {
        return NextResponse.json({ error: "Profile mismatch" }, { status: 400 });
      }
      expectedChallenge = challengeData.challenge;
    }

    // Find the stored credential this assertion claims to be: on the account
    // holding this name, from the credential index (Blob doc as fallback).
    const account = await dbResolveHandle(profile);
    const set = account ? await readCredentialSet(account) : null;
    const matchingCred = set?.credentials.find((c) => c && c.id === credential.id);
    if (!account || !set || !matchingCred) {
      return NextResponse.json({ error: "Unknown credential" }, { status: 400 });
    }
    if (!matchingCred.publicKey) {
      // Legacy credential from before public keys were stored — a signature can
      // never be verified against it. Fail closed and tell the client to
      // re-register (which heals it into a verifiable credential).
      return NextResponse.json(
        { error: "This passkey predates signature verification and must be set up again.", needsReregister: true },
        { status: 401 },
      );
    }

    // Really verify the assertion signature.
    const { acceptedRpIds, expectedOrigin } = rpConfigFromRequest(request);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: { ...credential, clientExtensionResults: credential.clientExtensionResults || {} },
        expectedChallenge,
        expectedOrigin,
        // Both rpIds while the window is open; the library reports the match.
        expectedRPID: acceptedRpIds,
        requireUserVerification: true,
        credential: {
          id: matchingCred.id,
          publicKey: new Uint8Array(Buffer.from(matchingCred.publicKey, "base64url")),
          counter: matchingCred.counter || 0,
          transports: matchingCred.transports,
        },
      });
    } catch (e) {
      return NextResponse.json({ error: `Authentication failed: ${e.message}` }, { status: 401 });
    }
    if (!verification.verified) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // Clone detection: persist the advanced signature counter. Platform
    // passkeys (Apple/Google) often report a constant 0, which the library
    // accepts; a hardware authenticator that ever regresses its counter would
    // have been rejected above.
    const newCounter = verification.authenticationInfo.newCounter;
    // Backfill the rpId the library matched, riding the counter write.
    const verifiedRpId = verification.authenticationInfo.rpID || null;
    // Consent rides the same write. Already on file at this version: nothing to stamp.
    const consentVersion = acceptedConsentVersion(consent);
    const stampConsent = !!consentVersion && set.consent?.version !== consentVersion;
    let consentRecorded = !!consentVersion && !stampConsent;
    let stampedConsent = null;

    // Blob mirror: today's write, under today's condition, on today's doc,
    // while the dual-write window is open.
    const credData = await credentialMirrorDoc(account, set);
    const docCred = credData?.credentials?.find((c) => c && c.id === matchingCred.id);
    const counterChanged = !!docCred && typeof newCounter === "number" && newCounter !== docCred.counter;
    const rpIdChanged = !!docCred && !!verifiedRpId && docCred.rpId !== verifiedRpId;
    if (credData && (counterChanged || rpIdChanged || stampConsent)) {
      try {
        const updated = {
          // Spread first: consent and any other top-level key survive the counter write.
          ...credData,
          credentials: credData.credentials.map((c) =>
            c.id === matchingCred.id
              ? {
                  ...c,
                  ...(counterChanged ? { counter: newCounter } : null),
                  ...(verifiedRpId ? { rpId: verifiedRpId } : null),
                }
              : c,
          ),
          ...(stampConsent ? { consent: { version: consentVersion, at: new Date().toISOString() } } : null),
        };
        // Write-first, sweep-after — see audit #6 / writeJsonReplacingPrefix.
        await writeJsonReplacingPrefix(credentialsPrefix(account.storageKey), credentialsPath(account.storageKey), updated);
        if (stampConsent) { consentRecorded = true; stampedConsent = updated.consent; }
      } catch {
        // A counter-persist failure must not deny an otherwise-valid login.
      }
    } else if (!credData && stampConsent) {
      // No doc to mirror onto: the account is the only record.
      stampedConsent = { version: consentVersion, at: new Date().toISOString() };
    }

    // Credential index (Neon): counter, rpId and last_used_at on every
    // verified sign-in (clone detection reads this counter), plus the consent
    // this sign-in stamped. A failure here never denies the login.
    try {
      await indexSignIn(account, matchingCred.id, { counter: newCounter, rpId: verifiedRpId, consent: stampedConsent });
      // No doc: the account write that just succeeded is the record.
      if (!credData && stampedConsent) consentRecorded = true;
    } catch (e) {
      console.error("[forge:credential-index]", e?.message || e);
    }

    // The account this ceremony proved control of; every token below is minted for it.
    const identity = { accountId: account.id, storageKey: account.storageKey };

    // Mint the short-lived ceremony token (Rec 11b: DB row; blob only as
    // the no-DB dev fallback — see mintAuthToken).
    const authToken = await mintAuthToken({ identity, ttlMs: 3600000, credentialId: matchingCred.id }); // 1 hour

    // Consume the challenge (blob mode only — stateless challenges are not
    // stored, and expire on their own).
    if (!stateless) await deleteByPrefix(challengeKey);

    // Forge's first cookie (boss call, 2026-07-21): a PHOTO-SCOPE token on a
    // SLIDING 7-day window — the photos gate silently rotates it on any
    // active day, so a device in use never re-auths; a quiet device dies in
    // 7 days (tighter than fixed-30 for lost phones).
    // httpOnly (JS can never read it — nothing plaintext to throw around),
    // Secure, SameSite=Strict, and PATH-SCOPED to /api/photos so it never
    // even accompanies any other request. scope:"photos" is rejected by the
    // wipe gate — destructive ops keep fresh short-lived ceremonies.
    const photoToken = quiet ? null : await mintAuthToken({ identity, ttlMs: 7 * 86400000, scope: "photos" });

    // Sync-scope cookie (J1, 2026-07-26). Sync is AMBIENT — visibility
    // change, reconnect, every mutation — so it cannot ride the in-memory
    // ceremony token, which dies with the tab and would demand Face ID
    // before a fresh tab could sync. Path-scoped to /api/sync, httpOnly so
    // JS never sees it. The wipe gate on that same
    // path rejects every scoped token, so this cookie can read and write a
    // profile but can never destroy one. Sliding 7 days — same window as
    // hw_photos: any active day rotates it, so a device in use never re-auths.
    const syncToken = quiet ? null : await mintAuthToken({ identity, ttlMs: 30 * 86400000, scope: "sync" });

    // A legacy-rpId login is a credential that stops working at the sunset.
    const onLegacyCredential = verifiedRpId === LEGACY_RP_ID;

    const res = NextResponse.json({
      ok: true, verified: true, profile: normalise(profile), authToken, expiresIn: 3600,
      // Single-admin recognition: a UI hint only — every admin surface
      // re-verifies the token's profile server-side.
      admin: isAdminIdentity(identity),
      // Present only when the request carried an accepted consent claim.
      ...(consentVersion ? { consentRecorded } : null),
      ...(onLegacyCredential
        ? {
            passkeyUpgrade: {
              needed: true,
              urgent: passkeyNudgeUrgent(),
              daysLeft: daysUntilPasskeySunset(),
            },
          }
        : null),
    });
    // Quiet: the ceremony token in the body is all this device keeps.
    if (quiet) return res;
    res.cookies.set("hw_photos", photoToken, {
      httpOnly: true, secure: true, sameSite: "strict", path: "/api/photos", maxAge: 7 * 86400,
    });
    res.cookies.set("hw_sync", syncToken, {
      // 30 days, matching the token TTL and the gate's sliding refresh —
      // the photos cookie deliberately stays at 7.
      httpOnly: true, secure: true, sameSite: "strict", path: "/api/sync", maxAge: 30 * 86400,
    });
    return res;
  } catch (e) {
    return serverError(e, { label: "auth-login-verify" });
  }
}
