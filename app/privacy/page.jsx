// app/privacy/page.jsx — the privacy notice. Server-rendered, plain.
// Facts here are load-bearing: if storage, processors, cookies or retention
// change, this page changes in the same PR (tests/privacy.test.js pins the
// ones that live in code).
import Link from "next/link";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

const URL = "https://heatwayve.app/privacy";
export const UPDATED = "5 October 2026";
export const CONTACT = "ab@heatwayve.app";
export const ICO_REG = "ZC257208";

export const metadata = {
  title: "Privacy",
  description: "What Heatwayve collects, why, where it lives, and how to make it go away.",
  alternates: { canonical: URL },
};

const SECTIONS = [
  {
    h: "The short version",
    list: [
      "We ask for a name. Never an email or phone number.",
      "Your training lives on your device. We keep your name on our servers so no one else can take it; add a passkey and your training syncs to London so it can follow you.",
      "No ads, no ad trackers. We don't sell or share your data for marketing.",
      "Delete your profile and its training, photos and passkey go from our servers. If a trainer changed your plan, the record of those changes stays.",
    ],
  },
  {
    h: "Who we are",
    p: [`Heatwayve is run by Abrar Ahmed, who is responsible for your personal data (the "controller"), registered with the ICO as ${ICO_REG}. Questions, requests or complaints: ${CONTACT}.`],
  },
  {
    h: "What we collect, and why",
    list: [
      "The name you choose — held on our servers from the moment you create a profile, so it stays yours. Names are checked against ours as you type.",
      "A passkey, if you add one — to sign you in. We keep its public key and a few technical details (an ID, a sign-in counter, when it was made, and when you gave consent). Face ID, Touch ID and your device PIN never leave your device; your password manager keeps the passkey under your profile name.",
      "Your training, once you add a passkey: sessions (when they started, how long they took, your time zone), sets, weights, reps, effort ratings, readiness and its reason, breaks and their reason, schedule, focus, streak and the programme's working estimates — to run and adapt your programme.",
      "Bodyweight, and a dated log of it — to set loads and show your progress. It's also noted on each progress photo.",
      "Progress photos, only if you add them — stored privately and shown only to you after passkey sign-in. Location and camera data are stripped before upload.",
      "Bug reports you send — your message, profile name, the page you were on, your browser and device details, and when you sent it — so we can fix things.",
      "Usage and performance — page views, load times, and an anonymous count of finished sessions, through Vercel Web Analytics and Speed Insights. No name attached, no cookies, nothing that follows you across other sites.",
      "Your IP address — briefly, to stop abuse, and in our hosting provider's logs.",
      "An AI you connect, if you do — which app, which passkey approved it, and when it last read. It reads your training (never photos) only when you ask it to.",
      "A trainer you add, if you do — who they are, when sharing started and ended, when they looked and, if they change your plan, each change with what it was before. See \"A trainer you add\" below.",
      "Coaching, if you apply or become a trainer — what you wrote and your link, the decision, when you accepted the Trainer Terms and that you're 18 or over, and your invite code, kept only as a hash.",
      "Anything you email us, if you do.",
    ],
  },
  {
    h: "Health information",
    p: [
      "Readiness and its reasons, breaks (including \"injured or ill\"), bodyweight, training and photos can say something about your health, which UK law treats as special category data. We only use it with your explicit consent, and only to run Heatwayve for you and to share it with a trainer you add. You give it when you add a passkey. If you added one before 29 September 2026, you gave it by entering your data, and we'll ask you once, on your profile, to confirm. Withdraw consent any time by deleting your profile (photos can also be deleted one by one in the Locker Room). For a trainer, you give it when you approve them, and withdraw it by stopping sharing.",
    ],
  },
  {
    h: "Our lawful bases",
    list: [
      "Providing the app you asked for (contract) — your name, passkey and training.",
      "Explicit consent — health information, progress photos, and sharing with a trainer you add.",
      "Legitimate interests — keeping the service secure and working (rate limiting, logs), measuring performance, and handling bug reports and emails.",
    ],
  },
  {
    h: "Where it lives, and who helps us",
    list: [
      "Vercel — delivers the app worldwide; the server functions that handle your data run in London. Also runs the analytics above.",
      "Neon — our database, in London.",
      "Vercel Blob — private file storage in London for passkey public keys, progress photos, backups, and older copies of some profiles' training.",
      "YouTube — demo videos embed in privacy-enhanced mode. Opening one connects your browser to Google, under its own privacy policy. Some links open YouTube itself, where its usual terms and cookies apply.",
      "Buy Me a Coffee — if you tip, that happens on their site under their policy. They may pass us your supporter name and message.",
      "An AI you connect — what it reads is handled under that AI's own terms. Disconnect it any time under Coaching, on your profile. Removing the passkey that approved it ends the connection too.",
      "A trainer you add — sees only what's set out below, and is responsible for what they do with it.",
    ],
    p: [
      "Our providers are US companies and may access data from outside the UK. Where they do, it's under UK-approved safeguards, such as the UK Extension to the EU–US Data Privacy Framework or the UK International Data Transfer Addendum.",
      "If you use \"Copy your training\" and paste it into an AI service, that copy is yours to share — the service you paste it into handles it under its own terms. We don't send it anywhere.",
    ],
  },
  {
    h: "A trainer you add",
    list: [
      "You add a trainer yourself, with the code they show you and your passkey. That approval is your consent to share; no one else can give it for you.",
      "They see your last 24 weeks of training in full — sessions, sets, weights, reps, effort and how you felt — and your main-lift trend and bests over 12 months. Their client list shows when you last trained, your sessions this week against your plan, and your recent rhythm. Breathers show as paused.",
      "They never see your photos, bodyweight, sleep, why you took a breather, what time of day you trained, or your notes.",
      "Each look, and a once-a-day check-in from their client list, shows on your profile. Stop sharing in one tap, and they lose access straight away.",
      "While their changes are on, they also see your current working weights, reps and main lifts for every lift in your programme, whether you're on a deload, your planned week up to 4 weeks ahead, and each lift's most recent top set, however long ago. The top set is what keeps their changes within safe limits.",
      "They can change your working weights, reps and main lifts from your next session on, within the app's limits. Each change is checked against your training, and your app makes it the next time you open it.",
      "Turn their changes off in one tap in Profile and keep sharing. Turning them off, or stopping sharing, cancels any change that hasn't reached your plan yet.",
      "If your trainer can change your plan, each change is kept with what it was before, so you can see and undo it.",
      "What your trainer does with what they see is their responsibility. Under the Trainer Terms, they use it only to coach you and keep it private.",
      "Nothing is deleted when sharing ends. The record of it keeps its dates: who, when it started and ended, and the last 20 looks. It never holds your training.",
    ],
  },
  {
    h: "Cookies and on-device storage",
    list: [
      "One strictly necessary cookie keeps sync signed in; a second keeps photos unlocked. Each renews while you use the app and lapses after 30 days (sync) or 7 days (photos) unused. If you're a trainer, a third keeps your trainer dashboard signed in; it lapses after 14 days unused, or 30 days after you signed in, whichever comes first. None of them tracks you.",
      "Your training is kept in your browser's storage on your device. Photos you view may sit briefly in your browser's cache.",
      "No advertising or tracking cookies. If you open a demo video, YouTube may set its own.",
    ],
  },
  {
    h: "How long we keep it",
    list: [
      "Your training — until you delete your profile. Training can't be removed one session at a time on our servers. Your name stays on a closed record, so no one else's data is ever attached to it.",
      "Photos — until you delete them or your profile.",
      "Backups — refreshed daily and weekly, deleted with your profile. Our database provider keeps a short restore history that expires on its own.",
      "Sign-in records — each works for 30 days at most. The records (your profile name and dates) stay until you delete your profile.",
      "AI connections — the record of which app you connected (never your training) stays after you delete your profile, and can't read anything once your profile and passkey are gone. Ask and we'll remove it.",
      "Trainer sharing — the record of it (who, the dates, the last 20 looks, never your training) stays after sharing ends and after you delete your profile.",
      "Trainer changes — each change to your plan, with what it was before and after, what it was checked against, who made it and when, stays after sharing ends and after you delete your profile.",
      "Coaching records — your Terms acceptance, invite codes and the decision on your application stay after you delete your profile; what you wrote on it is cleared.",
      "Bug reports — not removed when you delete your profile. Ask and we'll delete yours.",
      "Server logs, which can include your profile name — kept briefly by our hosting provider.",
      "No passkey? Your name (and anything synced before 27 July 2026) stays until you add one and delete your profile, or email us.",
      "Data on your device — until you clear it or remove the app.",
    ],
  },
  {
    h: "Your rights",
    p: [
      "You can ask to access, correct, delete, restrict or move your data, object to how we use it, or withdraw consent. Much of it you can do yourself: delete photos in the Locker Room, delete your profile and its server data from the profile page (your passkey proves it's you), or copy a summary of your recent training from AI coaching. For a full copy, or anything else, email us — we'll reply within a month.",
    ],
  },
  {
    h: "Age",
    p: ["Heatwayve is for adults, 18 and over."],
  },
  {
    h: "Complaints",
    p: [
      `Tell us first at ${CONTACT} — we'll acknowledge it within 30 days. If you're still unhappy, you can complain to the ICO, the UK's data protection regulator: Wycliffe House, Water Lane, Wilmslow, Cheshire SK9 5AF · 0303 123 1113 · ico.org.uk/make-a-complaint.`,
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
