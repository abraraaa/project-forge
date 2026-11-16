import { NextResponse } from "next/server";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// WebAuthn Related Origin Requests: an origin listed here may run a ceremony
// that declares rpId heatwayve.app (Safari 18+, Chrome 128+). Credentials
// minted under rpId theforged.fit are no longer accepted, so the old-domain
// entries matter only while that host still serves the auth routes (the
// redirect carve-out in next.config.mjs).
export async function GET() {
  return NextResponse.json(
    {
      origins: [
        "https://theforged.fit",
        "https://www.theforged.fit",
        "https://heatwayve.app",
        "https://www.heatwayve.app",
      ],
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
