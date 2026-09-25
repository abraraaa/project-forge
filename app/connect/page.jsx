// app/connect/page.jsx — the OAuth authorize step for "Connect your AI".
// The server checks the request against the registered app before anything
// renders; the page itself only asks for a name and a Face ID.
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { rateLimit } from "@/lib/rate-limit";
import { neonOAuthStore } from "@/lib/oauth-store";
import { resolveClient } from "@/lib/oauth-cimd";
import { checkAuthorizeParams, redirectWith } from "@/lib/oauth-http";
import ConnectView from "@/components/ConnectView";
import { T, DISPLAY } from "@/lib/tokens";

export const dynamic = "force-dynamic";
// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

export const metadata = {
  title: "Connect your AI",
  robots: { index: false, follow: false },
};

const first = (v) => (Array.isArray(v) ? v[0] : v);

function Refusal({ message }) {
  return (
    <div style={{ maxWidth: 430, margin: "0 auto", padding: "72px 24px 48px", fontFamily: T.text }}>
      <div style={{ fontSize: 13, color: T.ink2, marginBottom: 8 }}>Connect your AI</div>
      <h1 style={{ ...DISPLAY, fontSize: 34, color: T.ink, margin: "0 0 10px" }}>That didn't work</h1>
      <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6 }}>{message}</p>
    </div>
  );
}

export default async function ConnectPage({ searchParams }) {
  const raw = await searchParams;
  /** @type {Record<string, string | undefined>} */
  const q = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, first(v)]));
  // This page can fetch a client's metadata document (CIMD), so it is an
  // outbound-request endpoint: rate-limited like the API routes.
  if (rateLimit(/** @type {any} */ ({ headers: await headers() }), "oauth-connect", 20)) {
    return <Refusal message="Too many attempts. Wait a minute, then start again from your AI." />;
  }
  const store = await neonOAuthStore();
  const client = store && q.client_id ? await resolveClient(store, q.client_id) : null;
  const checked = checkAuthorizeParams(q, client);
  if (checked.redirectError) redirect(redirectWith(q.redirect_uri, { error: checked.redirectError, state: q.state }));
  if (checked.fatal || !client) {
    return <Refusal message={checked.fatal || "Connections are unavailable right now. Start again from your AI."} />;
  }
  return (
    <ConnectView
      clientName={client.name}
      host={new URL(checked.ok.redirectUri).host}
      params={q}
    />
  );
}
