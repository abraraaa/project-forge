import { NextResponse } from "next/server";

// WebAuthn Related Origin Requests (migration challenge 1, 2026-07-22).
// Served for theforged.fit (the rpId domain): browsers consult
// https://theforged.fit/.well-known/webauthn before allowing a ceremony for
// an rpId="theforged.fit" credential from a DIFFERENT origin. Listing the
// heatwayve origins here is what lets existing passkeys keep working after
// the domain flip — and lets new ones be minted from heatwayve.app under
// the same rpId (single lock, two doors). Safari 18+/Chrome 128+.
// AT FLIP: this path must stay served on theforged.fit (carve-out from the
// reverse 301), or every legacy passkey breaks mid-ceremony.
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
