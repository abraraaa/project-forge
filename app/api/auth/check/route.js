import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { readJsonByPrefix } from "@/lib/blob-utils";
import { hasUsablePasskey, credentialRpId } from "@/lib/auth-server";
import { acceptedRpIds } from "@/lib/origin";

// Check whether a profile has a VERIFIABLE passkey registered.
// GET /api/auth/check?profile=Name
//
// "Verifiable" means the stored credential carries a public key. A keyless
// legacy credential (written by the pre-2026-07-15 code) reports false here so
// the UI re-offers setup — re-registration heals it into a real credential.
// See lib/auth-server.js for the doctrine.

const normalise = (name) => String(name || "").trim().toLowerCase();
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;

export async function GET(request) {
  const limited = rateLimit(request, "auth-check", 60);
  if (limited) return limited;
  try {
    const { searchParams } = new URL(request.url);
    const profile = searchParams.get("profile");
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    const credData = await readJsonByPrefix(credentialsPrefix(profile));
    // "Can they still get in", not "is there a record".
    const accepted = acceptedRpIds();
    const has = hasUsablePasskey(credData, accepted);
    const usable = new Set([...accepted, "localhost"]);

    return NextResponse.json({
      hasPasskey: has,
      credentialCount: has
        ? credData.credentials.filter((c) => c.publicKey && usable.has(credentialRpId(c))).length
        : 0,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
