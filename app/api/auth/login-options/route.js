import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { put } from "@vercel/blob";
import crypto from "crypto";
import { readJsonByPrefix } from "@/lib/blob-utils";
import { hasChallengeSecret, issueChallenge } from "@/lib/auth-server";

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
    
    if (!credData?.credentials?.length) {
      return NextResponse.json(
        { error: "No passkey registered for this profile" },
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

    // RP ID must be consistent between registration and authentication
    const host = request.headers.get("host") || "";
    const rpId = host.includes("localhost") ? "localhost" : "theforged.fit";

    return NextResponse.json({
      challenge,
      rpId,
      timeout: 60000,
      allowCredentials: credData.credentials.map(cred => ({
        id: cred.id, // Use credential id, not rawId
        type: "public-key",
        transports: ["internal", "hybrid"],
      })),
      userVerification: "required",
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
