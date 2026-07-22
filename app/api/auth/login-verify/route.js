import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import crypto from "crypto";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { readJsonDirect, readJsonByPrefix, deleteByPrefix, writeJsonReplacingPrefix } from "@/lib/blob-utils";
import { rpConfigFromRequest, hasChallengeSecret, verifyChallenge } from "@/lib/auth-server";

// Verify WebAuthn authentication and mint a short-lived auth token.
// POST /api/auth/login-verify
// Body: { profile, credential: { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle } } }
//
// The assertion signature is now REALLY verified against the stored public key
// (over authenticatorData ‖ SHA-256(clientDataJSON)), along with the challenge,
// origin, rpId, and user-presence/verification flags. Only then is a token
// minted. Previously the route checked the challenge and that the credential id
// existed, then trusted the browser — but login-options hands the credential id
// to any caller, so the token was forgeable by anyone who knew a profile name.
// That token is the sole gate on destructive DELETE, so the padlock was
// decorative. It isn't anymore.

const normalise = (name) => String(name || "").trim().toLowerCase();
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;
const credentialsPath = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`;

export async function POST(request) {
  try {
    const { profile, credential } = await request.json();
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

    // Find the stored credential this assertion claims to be.
    const credData = await readJsonByPrefix(credentialsPrefix(profile));
    const matchingCred = credData?.credentials?.find((c) => c.id === credential.id);
    if (!matchingCred) {
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
    const { rpId, expectedOrigin } = rpConfigFromRequest(request);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: { ...credential, clientExtensionResults: credential.clientExtensionResults || {} },
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpId,
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
    if (typeof newCounter === "number" && newCounter !== matchingCred.counter) {
      try {
        const updated = {
          credentials: credData.credentials.map((c) =>
            c.id === matchingCred.id ? { ...c, counter: newCounter } : c,
          ),
        };
        // Write-first, sweep-after — see audit #6 / writeJsonReplacingPrefix.
        await writeJsonReplacingPrefix(credentialsPrefix(profile), credentialsPath(profile), updated);
      } catch {
        // A counter-persist failure must not deny an otherwise-valid login.
      }
    }

    // Mint the short-lived token (deterministic key, overwrite-in-place).
    const authToken = crypto.randomBytes(32).toString("base64url");
    await put(`forge/tokens/${authToken}`, JSON.stringify({
      profile: normalise(profile),
      expires: Date.now() + 3600000, // 1 hour
      createdAt: new Date().toISOString(),
    }), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

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
    const photoToken = crypto.randomBytes(32).toString("base64url");
    await put(`forge/tokens/${photoToken}`, JSON.stringify({
      profile: normalise(profile),
      expires: Date.now() + 7 * 86400000,
      scope: "photos",
      createdAt: new Date().toISOString(),
    }), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });

    const res = NextResponse.json({ ok: true, verified: true, profile: normalise(profile), authToken, expiresIn: 3600 });
    res.cookies.set("hw_photos", photoToken, {
      httpOnly: true, secure: true, sameSite: "strict", path: "/api/photos", maxAge: 7 * 86400,
    });
    return res;
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
