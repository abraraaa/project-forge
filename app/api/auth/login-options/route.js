import { NextResponse } from "next/server";
import { serverError } from "@/lib/api-errors";
import { rateLimit } from "@/lib/rate-limit";
import { put } from "@vercel/blob";
import crypto from "crypto";
import { readJsonByPrefix } from "@/lib/blob-utils";
import { hasChallengeSecret, issueChallenge, rpConfigFromRequest, planLoginCeremony } from "@/lib/auth-server";

// Generate authentication options for WebAuthn
// POST /api/auth/login-options
// Body: { profile: string }

const normalise = (name) => String(name || "").trim().toLowerCase();
// Note: Vercel Blob addRandomSuffix inserts BEFORE extension
// So credentials.json becomes credentials-ABC123.json
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;

export async function POST(request) {
  const limited = rateLimit(request, "auth-login", 20);
  if (limited) return limited;
  try {
    const { profile } = await request.json();
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    // Find credentials for this profile
    const credData = await readJsonByPrefix(credentialsPrefix(profile));

    // Planned before the challenge. A ceremony is single-rpId, so this picks
    // one pool and offers only its credentials. Null reads as "no passkey".
    const config = rpConfigFromRequest(request);
    const plan = planLoginCeremony(credData, config);
    if (!plan) {
      return NextResponse.json(
        { error: "No passkey registered for this profile", needsRegister: true },
        { status: 404 }
      );
    }

    // Challenge: signed & stateless when CHALLENGE_SECRET is set (no blob
    // round-trip → no "No pending authentication" race); otherwise fall back
    // to the short-lived challenge blob. See lib/auth-server.js.
    let challenge;
    if (hasChallengeSecret()) {
      challenge = issueChallenge(profile, "auth");
    } else {
      challenge = crypto.randomBytes(32).toString("base64url");
      const userId = crypto.createHash("sha256").update(normalise(profile)).digest("base64url");
      await put(`forge/challenges/${userId}`, JSON.stringify({
        challenge,
        profile: normalise(profile),
        expires: Date.now() + 120000,
        type: "login",
      }), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    }

    return NextResponse.json({
      challenge,
      rpId: plan.rpId,
      timeout: 60000,
      allowCredentials: plan.credentials.map(cred => ({
        id: cred.id, // Use credential id, not rawId
        type: "public-key",
        transports: cred.transports?.length ? cred.transports : ["internal", "hybrid"],
      })),
      userVerification: "required",
    });
  } catch (e) {
    return serverError(e, { label: "auth-login-options" });
  }
}
