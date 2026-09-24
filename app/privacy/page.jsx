// app/privacy/page.jsx — the privacy notice. Server-rendered, plain.
// Facts here are load-bearing: if storage, processors, cookies or retention
// change, this page changes in the same PR (tests/privacy.test.js pins the
// ones that live in code).
import Link from "next/link";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

const URL = "https://heatwayve.app/privacy";
export const UPDATED = "24 September 2026";
export const CONTACT = "ab@heatwayve.app";

export const metadata = {
  title: "Privacy",
  description: "What Heatwayve collects, why, where it lives, and how to make it go away.",
  alternates: { canonical: URL },
};

const SECTIONS = [
  {
    h: "The short version",
    list: [
      "We ask for a name, never an email or phone number.",
      "Your training lives on your device first. Add a passkey and it syncs to our servers in London so it can follow you.",
      "No ads, no ad trackers, and we don't sell or share your data for marketing.",
      "Delete your profile and it's gone from our servers — photos included.",
    ],
  },
  {
    h: "Who we are",
    p: [`Heatwayve is run by Abrar Ahmed, who is responsible for your personal data (the "controller"). Questions, requests or complaints: ${CONTACT}.`],
  },
  {
    h: "What we collect, and why",
    list: [
      "The profile name you choose — to identify your profile.",
      "A passkey's public key, if you add one — to sign you in. Face ID, Touch ID and your device PIN never leave your device; we only hold a public key.",
      "Your training: sessions, sets, weights, reps, effort ratings, readiness, schedule, focus and main-lift choices — to run and adapt your programme.",
      "Bodyweight — to load bodyweight exercises correctly and show your progress.",
      "Progress photos, only if you add them — stored privately and shown only to you after passkey sign-in. We strip location and camera data before upload.",
      "Bug reports you choose to send — your message, profile name, the page you were on and your browser type, so we can fix things.",
      "Usage and performance measurements — page views and load times through Vercel Web Analytics and Speed Insights. These use no cookies and don't follow you across other sites.",
    ],
  },
  {
    h: "Health information",
    p: [
      "Training, readiness, bodyweight and photos can say something about your health, which UK law treats as special category data. We only use it with your explicit consent, which you give by entering it, and only to provide Heatwayve to you. You can withdraw that consent at any time by deleting it or your profile.",
    ],
  },
  {
    h: "Our lawful bases",
    list: [
      "Providing the app you asked for (contract) — your profile, passkey and training data.",
      "Explicit consent — health information and progress photos.",
      "Legitimate interests — keeping the service secure and working (rate limiting, error logs), measuring performance, and handling bug reports and questions.",
    ],
  },
  {
    h: "Where it lives, and who helps us",
    list: [
      "Vercel — hosts the app and runs its server functions in London; provides the analytics above.",
      "Neon — our database, in London.",
      "Vercel Blob — private storage for photos and backups, in London.",
      "YouTube — exercise demo videos are embedded in privacy-enhanced mode. When you play one, Google processes that under its own privacy policy.",
    ],
    p: [
      "Our providers are US companies and may access data from outside the UK. Where they do, it's under UK-approved safeguards, such as the UK Extension to the EU–US Data Privacy Framework or the UK International Data Transfer Addendum.",
      "If you use \"Copy your training\" and paste it into an AI service, that copy is yours to share — the service you paste it into handles it under its own terms. We don't send it anywhere.",
    ],
  },
  {
    h: "Cookies and on-device storage",
    list: [
      "One strictly necessary cookie keeps your sync signed in for up to 30 days, and a second keeps your photos unlocked for up to 7. Neither tracks you.",
      "Your training is kept in your browser's local storage on your device.",
      "No advertising or tracking cookies.",
    ],
  },
  {
    h: "How long we keep it",
    list: [
      "Profile, training data and photos — until you delete them or your profile.",
      "Server backups of your profile — overwritten daily and weekly, and removed when you delete your profile.",
      "Sign-in tokens — up to 30 days.",
      "Bug reports — kept so fixes can be tracked. Ask and we'll delete yours.",
      "Server logs — kept briefly by our hosting provider.",
      "Data only on your device — until you clear it or remove the app.",
    ],
  },
  {
    h: "Your rights",
    p: [
      "You can ask to access, correct, delete, restrict or move your data, object to how we use it, or withdraw consent. Much of it you can do yourself: delete photos in the Locker Room, remove your profile and its server data from the profile page, or copy your training out from AI coaching. For anything else, email us — we'll reply within a month.",
    ],
  },
  {
    h: "Age",
    p: ["Heatwayve is for adults and isn't intended for anyone under 16."],
  },
  {
    h: "Complaints",
    p: [
      `Tell us first at ${CONTACT}. If you're still unhappy, you can complain to the Information Commissioner's Office: Wycliffe House, Water Lane, Wilmslow, Cheshire SK9 5AF · 0303 123 1113 · ico.org.uk/make-a-complaint.`,
    ],
  },
  {
    h: "Changes",
    p: ["If this changes, we'll update this page and the date at the top. This notice isn't legal advice to you; it's our account of what we do."],
  },
];

const H2 = { fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 12px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` };
const P = { fontSize: 15, color: T.ink2, lineHeight: 1.6, margin: "0 0 10px" };

export default function PrivacyPage() {
  return (
    <div style={{ padding: "40px 24px 64px", maxWidth: 640, margin: "0 auto", fontFamily: T.text }}>
      <Link href="/" style={{ fontSize: 13, color: T.ink2, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Glyph name="arrowLeft" size={12} color={T.ink3} /> Heatwayve
      </Link>
      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>Updated {UPDATED}</div>
        <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: 0 }}>Privacy</h1>
        <p style={{ ...P, fontSize: 16, marginTop: 14 }}>Your training is yours. Here's exactly what we hold, and how to make it go away.</p>
      </div>
      {SECTIONS.map((s) => (
        <section key={s.h} style={{ marginTop: 36 }}>
          <h2 style={H2}>{s.h}</h2>
          {s.list && (
            <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
              {s.list.map((li) => <li key={li} style={{ ...P, margin: "0 0 8px" }}>{li}</li>)}
            </ul>
          )}
          {(s.p || []).map((t) => <p key={t} style={P}>{t}</p>)}
        </section>
      ))}
    </div>
  );
}
