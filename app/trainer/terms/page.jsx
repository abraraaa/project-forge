// app/trainer/terms/page.jsx — the Trainer Terms. Server-rendered, plain, like
// /privacy. DRAFT: the owner's text replaces this. Changing the words means
// bumping TRAINER_TERMS_VERSION in lib/trainer-terms.js, so trainers re-accept.
import Link from "next/link";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

const KICKER = "DRAFT";
const CONTACT = "ab@heatwayve.app";

export const metadata = {
  title: "Trainer Terms",
  description: "The terms for trainers who see training their clients share.",
  robots: { index: false, follow: true },
};

const SECTIONS = [
  {
    h: "Who we are",
    p: [`Heatwayve is run by Abrar Ahmed, a sole trader in the UK. These terms are between you, as a trainer, and Heatwayve. Questions: ${CONTACT}.`],
  },
  {
    h: "Who can be a trainer",
    list: [
      "You're 18 or over.",
      "You coach for yourself or your own business.",
      "Being a trainer on Heatwayve is free. If that ever changes, we'll tell you first.",
    ],
  },
  {
    h: "What you see",
    p: [
      "A client adds you themselves, with your code and their passkey. You then see what they agree to share: their last 24 weeks of training and how they felt, their main-lift trend and bests over 12 months, and, on your client list, when they last trained, their sessions this week against their plan, and their recent rhythm.",
      "You never see their photos, bodyweight, sleep, why they took a breather, what time of day they trained, or their notes. Your client sees each look, and a once-a-day check-in from your client list.",
      "While a client has your changes on, you also see their current working weights, reps and main lifts for every lift in their programme, whether they're on a deload, their planned week up to 4 weeks ahead, and each lift's most recent top set, however long ago. You can change their working weights, reps and main lifts from their next session on, within the app's limits. Their app makes each change the next time they open it. They see every change with what it was before, can undo it, and can turn your changes off. Their logged sessions never change. If they turn your changes off or stop sharing, anything not yet in their plan is cancelled.",
    ],
  },
  {
    h: "What you agree to",
    list: [
      "Use what a client shares only to coach that client.",
      "Change a client's plan only to coach them.",
      "Keep it private. Don't pass it on, sell it or publish it, and don't share it with another service.",
      "You decide what you do with what you see, so you're responsible for it under data protection law, as its controller. Your own private coaching notes are fine: keep them secure, and delete them when you stop coaching that client.",
      "A copy you download of what a client shares is still their data. Delete it when they stop sharing with you, or if they ask.",
    ],
  },
  {
    h: "When access ends",
    list: [
      "Your client can stop sharing at any time, and your access ends straight away.",
      "It also ends if you stop seeing them, or if either of you closes your account.",
      "We may pause or end your trainer access if you misuse what a client shares or break these terms.",
    ],
  },
  {
    h: "Our part",
    p: [
      "We run the service as it is, free, and do our best to keep it working and secure. Your coaching is yours: we're not responsible for the advice you give, or for what you do with what you see. Nothing here limits anything the law doesn't let us limit.",
    ],
  },
  {
    h: "Changes",
    p: ["If these terms change, we'll ask you to accept the new version before you see your clients' training again."],
  },
  {
    h: "Law",
    p: ["These terms are governed by the law of England and Wales, and its courts deal with any dispute."],
  },
];

const H2 = { fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 12px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` };
const P = { fontSize: 15, color: T.ink2, lineHeight: 1.6, margin: "0 0 10px" };

export default function TrainerTermsPage() {
  return (
    <div style={{ padding: "40px 24px 64px", maxWidth: 640, margin: "0 auto", fontFamily: T.text }}>
      <Link href="/" style={{ fontSize: 13, color: T.ink2, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Glyph name="arrowLeft" size={12} color={T.ink3} /> Heatwayve
      </Link>
      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>{KICKER}</div>
        <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: 0 }}>Trainer Terms</h1>
        <p style={{ ...P, fontSize: 16, marginTop: 14 }}>Your clients choose to share their training with you. Here's what that asks of you.</p>
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
