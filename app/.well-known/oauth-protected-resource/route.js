import { protectedResourceMetadata, oauthJson, preflight } from "@/lib/oauth-http";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// RFC 9728: where an AI finds out who guards /mcp.
export function GET() { return oauthJson(protectedResourceMetadata()); }
export function OPTIONS() { return preflight(); }
