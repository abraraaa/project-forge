// Path-suffixed variant (RFC 9728 §3.1) — MCP clients try this first.
export { GET, OPTIONS } from "../route";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
