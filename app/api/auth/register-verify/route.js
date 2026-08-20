import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import crypto from "crypto";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { readJsonDirect, readJsonByPrefix, deleteByPrefix, writeJsonReplacingPrefix } from "@/lib/blob-utils";
import { rpConfigFromRequest, verifyAuthToken, hasUsablePasskey, hasChallengeSecret, verifyChallenge, mintAuthToken } from "@/lib/auth-server";

// Verify WebAuthn registration and store the credential's PUBLIC KEY.
// POST /api/auth/register-verify
// Body: { profile, credential: { id, rawId, type, response: { clientDataJSON, attestationObject } }, authToken? }
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

const normalise = (name) => String(name || "").trim().toLowerCase();
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;
// addRandomSuffix inserts BEFORE the extension, so this is the write path.
const credentialsPath = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`;

export async function POST(request) {
  const limited = rateLimit(request, "auth-register", 15);
  if (limited) return limited;
  try {
    const { profile, credential, authToken } = await request.json();
    if (!profile || !credential) {
      return NextResponse.json({ error: "Missing profile or credential" }, { status: 400 });
    }

    // Challenge validation. Stateless (signed) when CHALLENGE_SECRET is set —
    // no blob round-trip; otherwise validate the stored challenge blob.
    const stateless = hasChallengeSecret();
    const userId = crypto.createHash("sha256").update(normalise(profile)).digest("base64url");
    const challengeKey = `forge/challenges/${userId}`;
    let expectedChallenge;
    if (stateless) {
      expectedChallenge = (c) => verifyChallenge(c, profile, "reg");
    } else {
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
    }

    // Anti-stuffing gate: adding a credential to a profile that already holds a
    // VERIFIABLE passkey requires proving control of an existing one. Keyless
    // legacy credentials do not count as protection (see lib/auth-server.js),
    // so a legacy user can re-register freely and heal into a real credential.
    const existing = (await readJsonByPrefix(credentialsPrefix(profile))) || { credentials: [] };
    // hasUsablePasskey, not hasRealPasskey: once the legacy rpId retires, a
    // legacy-only profile has no ceremony left to prove control with, so
    // demanding one would strand its owner. It reverts to the bootstrap claim
    // — the same posture as a profile that never had a passkey.
    if (hasUsablePasskey(existing)) {
      const ok = await verifyAuthToken(profile, authToken);
      if (!ok) {
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
        // Both rpIds during the migration window. A credential minted from a
        // heatwayve origin is native; one minted on the old domain is legacy.
        // The library reports which matched, so it is recorded rather than
        // assumed.
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
    const newCredential = {
      id: vc.id,
      // Uint8Array → base64url for JSON storage; decoded back on login.
      publicKey: Buffer.from(vc.publicKey).toString("base64url"),
      counter: vc.counter,
      transports: vc.transports || credential.response?.transports || [],
      createdAt: new Date().toISOString(),
      // The rpId this credential is bound to, as VERIFIED — not as requested.
      // It is immutable for the life of the credential and decides which
      // ceremony can ever use it, so it comes from the library's match rather
      // than from what we asked for. Falls back to the requested rpId only if
      // a future library version stops reporting it.
      rpId: verification.registrationInfo.rpID || rpConfigFromRequest(request).rpId,
    };

    // Keep other REAL credentials (minus any id collision), DROP keyless legacy
    // placeholders — a successful real registration supersedes them so the
    // profile ends up with only verifiable credentials.
    const kept = existing.credentials.filter((c) => c && c.publicKey && c.id !== vc.id);
    const updated = { credentials: [...kept, newCredential] };

    // Write the new credentials blob FIRST, then sweep the old one — a
    // failure in between leaves two readable copies, never zero (audit #6;
    // the old delete-then-write order could destroy every passkey).
    await writeJsonReplacingPrefix(credentialsPrefix(profile), credentialsPath(profile), updated);

    // Consume the challenge (blob mode only — stateless challenges aren't stored).
    if (!stateless) await deleteByPrefix(challengeKey);

    // A freshly-registered passkey enables sync IMMEDIATELY (J1, 2026-07-26).
    // Without this the flow would be "register a passkey → now sign in with
    // it" — two ceremonies back to back for one intent. The user just proved
    // control of this profile with an authenticator; that IS the ceremony.
    const syncToken = await mintAuthToken({ profile, ttlMs: 30 * 86400000, scope: "sync" });
    // rpId is reported back so the client can tell a native mint from a legacy
    // one and only then retire its upgrade prompt.
    const res = NextResponse.json({ ok: true, credentialId: vc.id, rpId: newCredential.rpId });
    res.cookies.set("hw_sync", syncToken, {
      // 30 days, matching the token TTL and the gate's sliding refresh —
      // the photos cookie deliberately stays at 7.
      httpOnly: true, secure: true, sameSite: "strict", path: "/api/sync", maxAge: 30 * 86400,
    });
    return res;
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
