import { NextResponse } from "next/server";
import { serverError } from "@/lib/api-errors";
import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import crypto from "crypto";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { readJsonDirect, deleteByPrefix, writeJsonReplacingPrefix } from "@/lib/blob-utils";
import { rpConfigFromRequest, verifyAuthToken, hasUsablePasskey, isReclaimOfLapsedProfile, hasChallengeSecret, verifyChallenge, mintAuthToken } from "@/lib/auth-server";
import { normaliseProfile } from "@/lib/profile-name";
import { credentialsPrefix, credentialsPath, metaPath } from "@/lib/storage-keys";
import { acceptedConsentVersion } from "@/lib/consent";
import { indexRegistration, readCredentialSet, reclaimUserId, credentialHolder, credentialMirrorOpen, IDENTITY_BLOB_FALLBACK } from "@/lib/credential-store";
import { dbResolveHandle, dbReclaimHandle } from "@/lib/identity-store";
import { entitled } from "@/lib/entitlements";
import { put } from "@vercel/blob";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// Verify WebAuthn registration and store the credential's PUBLIC KEY.
// POST /api/auth/register-verify
// Body: { profile, credential: { id, rawId, type, response: { clientDataJSON, attestationObject } }, authToken?, consent?: { version } }
//
// The attestation is now really verified (challenge, origin, rpId, user
// verification) and the parsed public key is stored so authentication can
// check signatures. Two gaps this closes vs. the prior "trust the browser"
// version:
//   1. No key was stored, so login could never verify a signature (forgeable).
//   2. Registration was unauthenticated, so an attacker could staple their own
//      passkey onto someone else's already-protected profile (credential
//      stuffing). Adding a credential to a profile that ALREADY holds a
//      verifiable one now requires proving control via an existing passkey
//      (an authToken from login-verify). The FIRST passkey stays open — it is
//      the bootstrap claim, with nothing yet to authenticate against, and it
//      grants an attacker no delete power they didn't already have on an
//      unprotected profile.
// consent (optional) is stamped on the profile's credentials doc only after
// the attestation verifies; an unknown version is ignored. On a first-passkey
// (bootstrap) claim it proves only that whoever claimed this name agreed.
//
// A lapsed handle (passkeys on file, none usable) is not handed over: the
// registrant gets a NEW account with its own storage key, and the previous
// account keeps every byte of its data. Trainer handles never lapse.

const normalise = normaliseProfile;
// Credentials paths come from lib/storage-keys. addRandomSuffix inserts
// BEFORE the extension, so credentialsPath is the write path.

export async function POST(request) {
  const limited = rateLimit(request, "auth-register", 15) || await rateLimitShared(request, "auth-register", 15);
  if (limited) return limited;
  try {
    const { profile, credential, authToken, consent } = await request.json();
    if (!profile || !credential) {
      return NextResponse.json({ error: "Missing profile or credential" }, { status: 400 });
    }

    // Challenge validation. Stateless (signed) when CHALLENGE_SECRET is set —
    // no blob round-trip; otherwise validate the stored challenge blob.
    const stateless = hasChallengeSecret();
    const userId = crypto.createHash("sha256").update(normalise(profile)).digest("base64url");
    const challengeKey = `forge/challenges/${userId}`;
    let expectedChallenge;
    /** @type {string | undefined} user.id register-options carried for a reclaim (blob mode) */
    let carriedUserId;
    if (!stateless) {
      const challengeData = await readJsonDirect(challengeKey);
      if (!challengeData) {
        return NextResponse.json({ error: "No pending registration" }, { status: 400 });
      }
      if (Date.now() > challengeData.expires) {
        return NextResponse.json({ error: "Registration expired" }, { status: 400 });
      }
      if (challengeData.profile !== normalise(profile)) {
        return NextResponse.json({ error: "Profile mismatch" }, { status: 400 });
      }
      expectedChallenge = challengeData.challenge;
      carriedUserId = typeof challengeData.userId === "string" ? challengeData.userId : undefined;
    }

    // The account holding this name.
    const account = await dbResolveHandle(profile);
    if (!account) {
      return NextResponse.json({ error: "Profile not found. Create a profile first." }, { status: 404 });
    }

    // Anti-stuffing gate: adding a credential to a profile that already holds a
    // VERIFIABLE passkey requires proving control of an existing one. Keyless
    // legacy credentials do not count as protection (see lib/auth-server.js);
    // a profile holding only those has lapsed, and registering reclaims the
    // name as a new account (below).
    // The doc is read whatever the sign-in fallback says: the gate must see
    // every passkey on file, and the mirror write below replaces this doc.
    const set = await readCredentialSet(account, { probe: true, doc: true });
    const read = set.blobDoc;
    // readJsonByPrefix returns null for BOTH "no doc" and "read threw". A doc
    // that exists but won't read must not be treated as empty: the gate below
    // could be skipped, and the mirror write would sweep the unread doc.
    if (read === null) {
      if (set.blobUnreadable) {
        return NextResponse.json({ error: "Couldn't read this profile's passkeys. Try again in a moment." }, { status: 503 });
      }
    }
    // What stands before this registration: the doc's keys, the account's
    // passkeys (index plus doc).
    const existing = { ...(read || {}), credentials: set.credentials };
    const neverLapse = entitled(account, "handle.neverLapse");
    // From the credentials as they stand, before this registration.
    const reclaim = isReclaimOfLapsedProfile(existing) && !neverLapse;
    // hasUsablePasskey: a legacy-only profile has no ceremony left to prove
    // control with once the rpId retires, so it reverts to the bootstrap claim
    // (as a new account). A trainer's never does.
    const protectedNow = hasUsablePasskey(existing) || (neverLapse && existing.credentials.length > 0);
    // Options made the same reclaim-or-not call and baked the matching user.id
    // into the passkey: the signed challenge names it, the challenge blob
    // carries it. A call that has flipped since (e.g. across the rpId sunset)
    // fails here and the client starts over, so the recorded user handle is
    // always the one the passkey holds.
    if (stateless) {
      const ceremony = reclaim ? "reclaim" : "reg";
      expectedChallenge = (c) => verifyChallenge(c, profile, ceremony);
    } else if (!reclaim && carriedUserId) {
      return NextResponse.json({ error: "Registration expired" }, { status: 400 });
    }
    if (protectedNow) {
      const id = await verifyAuthToken(profile, authToken);
      if (!id || id.accountId !== account.id) {
        return NextResponse.json(
          {
            error: "This profile is already protected by a passkey. Authenticate with your existing passkey before adding another.",
            requiresAuth: true,
          },
          { status: 401 },
        );
      }
    }

    // Really verify the attestation and extract the public key.
    const { acceptedRpIds, expectedOrigin } = rpConfigFromRequest(request);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: { ...credential, clientExtensionResults: credential.clientExtensionResults || {} },
        expectedChallenge,
        expectedOrigin,
        // Both rpIds during the window; the library reports which matched.
        expectedRPID: acceptedRpIds,
        requireUserVerification: true,
      });
    } catch (e) {
      return NextResponse.json({ error: `Registration verification failed: ${e.message}` }, { status: 400 });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: "Registration could not be verified" }, { status: 400 });
    }

    const vc = verification.registrationInfo.credential;
    // A credential id the index already holds for another account (or, on a
    // reclaim, for anyone) fails the ceremony before any write: WebAuthn has
    // the RP refuse an id it already holds.
    const holder = await credentialHolder(vc.id);
    if (holder && (reclaim || holder !== account.id)) {
      return NextResponse.json({ error: "Registration could not be verified" }, { status: 400 });
    }
    const newCredential = {
      id: vc.id,
      // Uint8Array → base64url for JSON storage; decoded back on login.
      publicKey: Buffer.from(vc.publicKey).toString("base64url"),
      counter: vc.counter,
      transports: vc.transports || credential.response?.transports || [],
      createdAt: new Date().toISOString(),
      // As VERIFIED, not as requested. Immutable for the credential's life.
      rpId: verification.registrationInfo.rpID || rpConfigFromRequest(request).rpId,
    };

    // Consent belongs to the person, so it carries across their passkeys.
    // Same version already on file: keep its date. A new version replaces the
    // old record in place (lib/consent.js). A reclaim carries nothing over.
    const consentVersion = acceptedConsentVersion(consent);
    const priorConsent = reclaim ? undefined : set.consent ?? undefined;
    const nextConsent = consentVersion && priorConsent?.version !== consentVersion
      ? { version: consentVersion, at: new Date().toISOString() }
      : priorConsent;

    /** @type {{ accountId: string, storageKey: string }} */
    let target;
    if (reclaim) {
      // The user.id register-options baked in: derived from this ceremony's
      // (now verified) challenge, or carried in the challenge blob.
      let userHandle = carriedUserId;
      if (stateless) {
        const clientData = JSON.parse(Buffer.from(credential.response.clientDataJSON, "base64url").toString("utf8"));
        userHandle = reclaimUserId(clientData.challenge);
      }
      if (!userHandle) {
        return NextResponse.json({ error: "Registration expired" }, { status: 400 });
      }
      // One transaction: release the lapsed holder's handle row (UPDATE of
      // released_at), create the new account, its handle and this credential.
      // The previous account and everything keyed to it stay as they are.
      const made = await dbReclaimHandle({
        handle: profile,
        display: String(profile).trim(),
        fromAccountId: account.id,
        webauthnUserId: userHandle,
        consent: nextConsent,
        credential: newCredential,
      });
      if (!made || made.taken !== false) {
        return NextResponse.json({ error: "Name taken", exists: true }, { status: 409 });
      }
      target = { accountId: made.accountId, storageKey: made.storageKey };
      // Mirror doc and claim marker under the NEW storage key: a fresh prefix,
      // so neither write can reach the previous holder's blobs. The account
      // and its passkey are already committed, and the index is what sign-in
      // reads, so neither failure fails the registration.
      try {
        if (credentialMirrorOpen()) await writeJsonReplacingPrefix(credentialsPrefix(target.storageKey), credentialsPath(target.storageKey), {
          credentials: [newCredential], consent: nextConsent,
        });
      } catch (e) {
        console.error("[forge:reclaim-mirror]", e?.message || e);
      }
      try {
        // Seeds displayName into meta on first push, as a claim does. No overwrite.
        await put(metaPath(target.storageKey), JSON.stringify({
          displayName: String(profile).trim(),
          claimedAt: new Date().toISOString(),
          weights: {},
          reps: {},
          streak: { count: 0, lastDate: null },
        }), { access: "private", contentType: "application/json", addRandomSuffix: false });
      } catch (e) {
        console.error("[forge:reclaim-marker]", e?.message || e);
      }
    } else {
      target = { accountId: account.id, storageKey: account.storageKey };
      // Mirror doc, today's shape: keep other REAL credentials (minus any id
      // collision), DROP keyless legacy placeholders. Spread first: every
      // other top-level key on the doc survives this write.
      const kept = (Array.isArray(read?.credentials) ? read.credentials : []).filter((c) => c && c.publicKey && c.id !== vc.id);
      const updated = { ...existing, credentials: [...kept, newCredential], consent: nextConsent };

      // Write the new credentials blob FIRST, then sweep the old one — a
      // failure in between leaves two readable copies, never zero (audit #6;
      // the old delete-then-write order could destroy every passkey).
      const writeMirror = () => writeJsonReplacingPrefix(credentialsPrefix(account.storageKey), credentialsPath(account.storageKey), updated);
      // Credential index (Neon): INSERT the credential on this account with the
      // user.id register-options handed out, and mirror the consent onto it.
      const index = () => indexRegistration(account, newCredential, { userHandle: account.webauthnUserId, consent: nextConsent });
      if (IDENTITY_BLOB_FALLBACK) {
        // Sign-in also reads the doc: it goes first, and an index failure
        // never fails the registration.
        await writeMirror();
        try { await index(); } catch (e) { console.error("[forge:credential-index]", e?.message || e); }
      } else {
        // Sign-in reads only the index: it takes the passkey first, so a
        // failed INSERT leaves no doc-only passkey behind. The mirror is best-effort.
        await index();
        if (credentialMirrorOpen()) {
          try { await writeMirror(); } catch (e) { console.error("[forge:credential-mirror]", e?.message || e); }
        }
      }
    }

    // Consume the challenge (blob mode only — stateless challenges aren't stored).
    if (!stateless) await deleteByPrefix(challengeKey);

    // A freshly-registered passkey enables sync IMMEDIATELY (J1, 2026-07-26).
    // Without this the flow would be "register a passkey → now sign in with
    // it" — two ceremonies back to back for one intent. The user just proved
    // control of this profile with an authenticator; that IS the ceremony.
    const syncToken = await mintAuthToken({ identity: target, ttlMs: 30 * 86400000, scope: "sync" });
    const res = NextResponse.json({ ok: true, credentialId: vc.id, rpId: newCredential.rpId });
    res.cookies.set("hw_sync", syncToken, {
      // 30 days, matching the token TTL and the gate's sliding refresh —
      // the photos cookie deliberately stays at 7.
      httpOnly: true, secure: true, sameSite: "strict", path: "/api/sync", maxAge: 30 * 86400,
    });
    return res;
  } catch (e) {
    return serverError(e, { label: "auth-register-verify" });
  }
}
