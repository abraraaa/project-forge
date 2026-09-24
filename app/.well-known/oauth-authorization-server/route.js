import { authorizationServerMetadata, oauthJson, preflight } from "@/lib/oauth-http";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// RFC 8414 discovery.
export function GET() { return oauthJson(authorizationServerMetadata()); }
export function OPTIONS() { return preflight(); }
