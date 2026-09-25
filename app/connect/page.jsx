// app/connect/page.jsx — the OAuth authorize step for "Connect your AI".
// The server checks the request against the registered app before anything
// renders; the page itself only asks for a name and a Face ID.
import { redirect } from "next/navigation";
import { neonOAuthStore } from "@/lib/oauth-store";
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

export default async function ConnectPage({ searchParams }) {
  const raw = await searchParams;
  /** @type {Record<string, string | undefined>} */
  const q = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, first(v)]));
  const store = await neonOAuthStore();
  const client = store && q.client_id ? await store.getClient(q.client_id) : null;
  const checked = checkAuthorizeParams(q, client);
  if (checked.redirectError) redirect(redirectWith(q.redirect_uri, { error: checked.redirectError, state: q.state }));
  if (checked.fatal || !client) {
    return (
      <div style={{ maxWidth: 430, margin: "0 auto", padding: "72px 24px 48px", fontFamily: T.text }}>
        <div style={{ fontSize: 13, color: T.ink2, marginBottom: 8 }}>Connect your AI</div>
        <h1 style={{ ...DISPLAY, fontSize: 34, color: T.ink, margin: "0 0 10px" }}>That didn't work</h1>
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6 }}>
          {checked.fatal || "Connections are unavailable right now. Start again from your AI."}
        </p>
      </div>
    );
  }
  return (
    <ConnectView
      clientName={client.name}
      host={new URL(checked.ok.redirectUri).host}
      params={q}
    />
  );
}
