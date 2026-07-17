import { NextResponse } from "next/server";
import crypto from "crypto";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { readJsonDirect, readJsonByPrefix, deleteByPrefix, writeJsonReplacingPrefix } from "@/lib/blob-utils";
import { rpConfigFromRequest, verifyAuthToken, hasRealPasskey, hasChallengeSecret, verifyChallenge } from "@/lib/auth-server";

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
    if (hasRealPasskey(existing)) {
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
    const { rpId, expectedOrigin } = rpConfigFromRequest(request);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: { ...credential, clientExtensionResults: credential.clientExtensionResults || {} },
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpId,
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

    return NextResponse.json({ ok: true, credentialId: vc.id });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
