import { NextResponse } from "next/server";
import { serverError } from "@/lib/api-errors";
import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import crypto from "crypto";
import { hasChallengeSecret, issueChallenge, rpConfigFromRequest, isReclaimOfLapsedProfile } from "@/lib/auth-server";
import { normaliseProfile } from "@/lib/profile-name";
import { dbResolveHandle } from "@/lib/identity-store";
import { readCredentialSet, reclaimUserId } from "@/lib/credential-store";
import { newWebauthnUserId } from "@/lib/identity";
import { entitled } from "@/lib/entitlements";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// Generate registration options for WebAuthn
// POST /api/auth/register-options
// Body: { profile: string }

const normalise = normaliseProfile;

export async function POST(request) {
  const limited = rateLimit(request, "auth-register", 15) || await rateLimitShared(request, "auth-register", 15);
  if (limited) return limited;
  try {
    const { profile } = await request.json();
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    // The account holding this name (must exist to register a passkey).
    const account = await dbResolveHandle(profile);
    if (!account) {
      return NextResponse.json(
        { error: "Profile not found. Create a profile first." },
        { status: 404 }
      );
    }

    // A lapsed handle (passkeys on file, none usable) is reclaimed as a NEW
    // account at verify; trainer handles never lapse. Decided from the same
    // set verify reads (the doc included whatever the sign-in fallback says),
    // so the two calls agree.
    const { credentials } = await readCredentialSet(account, { doc: true });
    const lapsed = isReclaimOfLapsedProfile({ credentials }) && !entitled(account, "handle.neverLapse");

    // The challenge-blob key (fallback path) stays derived from the name: the
    // pre-account user.id formula, which is no longer the user.id itself.
    const userId = crypto.createHash("sha256").update(normalise(profile)).digest("base64url");

    // Challenge: signed & stateless when CHALLENGE_SECRET is set (no blob
    // round-trip → no "No pending authentication" race); otherwise fall back
    // to the short-lived challenge blob. See lib/auth-server.js.
    // WebAuthn user.id: the account's own. On a reclaim the new account does
    // not exist yet, so it is derived from the challenge (stateless) or carried
    // in the challenge blob, and verify records the same value.
    let challenge;
    let webauthnUserId = account.webauthnUserId;
    if (hasChallengeSecret()) {
      // The ceremony is signed in, so verify can only record this user.id.
      challenge = issueChallenge(profile, lapsed ? "reclaim" : "reg");
      if (lapsed) webauthnUserId = reclaimUserId(challenge);
    } else {
      challenge = crypto.randomBytes(32).toString("base64url");
      if (lapsed) webauthnUserId = newWebauthnUserId();
      const { put } = await import("@vercel/blob");
      await put(`forge/challenges/${userId}`, JSON.stringify({
        challenge, profile: normalise(profile), expires: Date.now() + 120000, ...(lapsed ? { userId: webauthnUserId } : null),
      }), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    }

    // Decided in lib/auth-server.js so options and verify cannot drift.
    const { rpId } = rpConfigFromRequest(request);

    return NextResponse.json({
      challenge,
      rp: {
        name: "Heatwayve",
        id: rpId,
      },
      user: {
        id: webauthnUserId,
        name: normalise(profile),
        displayName: profile,
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },   // ES256
        { alg: -257, type: "public-key" }, // RS256
      ],
      timeout: 60000,
      authenticatorSelection: {
        authenticatorAttachment: "platform", // Prefer Face ID / Touch ID / Windows Hello
        userVerification: "required",
        residentKey: "preferred",
      },
      attestation: "none",
    });
  } catch (e) {
    return serverError(e, { label: "auth-register-options" });
  }
}
