// scripts/shoot-screenshots.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Regenerates the PWA install-prompt screenshots referenced by
// public/manifest.json, using a SYNTHETIC profile. Never shoot these from a
// real account — the previous pair carried the operator's name and a stale
// brand string baked into the pixels, which no rename sweep can see.
//
// Playwright is deliberately NOT a dependency (the hygiene sweep removed it
// and a test keeps it out). Install it transiently instead:
//
//   npm run build
//   npx next start -p 3100 &
//   npm i playwright-core --no-save
//   node scripts/shoot-screenshots.mjs
//
// Set CHROME_PATH if the bundled browser lives elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = new URL("../public/screenshots/", import.meta.url).pathname;
const NAME = "Sam";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mondayOf = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
};

// FULL session composition — main lifts, supersets and finisher. Seeding only
// the main lifts leaves nearly every muscle under MEV, so the volume card
// renders as a wall of shortfall warnings: an install prompt that tells the
// viewer they're failing. [name, topWeight, reps, sets]
const LETTERS = ["a", "b", "c"];
const LIFTS = {
  a: [
    ["Barbell Back Squat", 102.5, 5, 3], ["Barbell Bench Press", 77.5, 5, 3],
    ["Barbell Reverse Lunge", 40, 10, 3], ["Chest-Supported DB Row", 27.5, 10, 4],
    ["Barbell Hip Thrust", 90, 10, 3], ["Landmine Press", 30, 10, 4],
    ["Hanging Leg Raise", null, 14, 3], ["Standing Calf Raise", 60, 15, 3],
  ],
  b: [
    ["Hex Bar Deadlift", 140, 5, 3], ["Barbell Overhead Press", 50, 5, 3],
    ["Leg Press", 160, 10, 3], ["Pull-Up", null, 8, 4],
    ["Bulgarian Split Squat", 22.5, 8, 3], ["Machine Hamstring Curl", 45, 10, 3],
    ["Tricep Pushdown", 32.5, 12, 3], ["Lateral Raise", 10, 12, 4],
  ],
  c: [
    ["Power Clean", 70, 3, 4],
    ["DB Walking Lunge", 20, 10, 3], ["Cable Lateral Raise", 9, 12, 4],
    ["Incline DB Press", 30, 10, 4], ["Seated Cable Row", 60, 10, 4],
    ["DB Curl", 14, 10, 4], ["Skullcrusher", 25, 10, 3],
    ["Face Pull", 25, 15, 4], ["Low-to-High Cable Crossover", 14, 15, 4],
  ],
};

// Eighteen sessions on a ~3-day cadence (~8 weeks), with load CLIMBING over
// time. Flat weights draw flat trend lines, which makes the Lab — the most
// visual surface in the app — look like it has nothing to say.
const SESSIONS = 18;
const history = [];
// Last session lands YESTERDAY so the current week carries tonnage — a shot
// whose tonnage strip reads "0 kg" with a spark dipping to zero advertises
// falling off, which is not the story an install prompt tells.
const cursor = new Date();
cursor.setDate(cursor.getDate() - 1);
for (let i = 0; i < SESSIONS; i++) {
  const letter = LETTERS[i % 3];
  const date = iso(cursor);
  // i counts BACKWARDS from today, so older sessions get a bigger discount.
  const cyclesBack = Math.floor(i / 3);
  history.push({
    id: new Date(`${date}T18:30:00.000Z`).toISOString(),
    date,
    dow: new Date(`${date}T12:00:00`).getDay(),
    profileName: NAME,
    schemaVersion: 3,
    session: `strength-${letter}`,
    blockNumber: 2,
    weekStart: mondayOf(date),
    scheduledLetter: letter.toUpperCase(),
    readiness: i % 4 === 0 ? "fresh" : "normal",
    blocks: [{
      exercises: LIFTS[letter].map(([name, topWeight, reps, setCount]) => {
        // Bodyweight movements carry no load; everything else climbs.
        const weight = topWeight === null
          ? null
          : Math.max(topWeight - cyclesBack * (topWeight > 100 ? 2.5 : 1.25), topWeight * 0.6);
        return {
          name,
          loadType: "total",
          sets: Array.from({ length: setCount }, (_, s) => ({
            weight,
            reps: s === setCount - 1 ? reps - 1 : reps,
            rpe: s === setCount - 1 && i % 3 === 0 ? "cooked" : "normal",
          })),
        };
      }),
    }],
  });
  cursor.setDate(cursor.getDate() - 3);
}
history.sort((a, b) => a.id.localeCompare(b.id));

const seed = {
  "forge:onboarded": true,
  "forge:profiles": [NAME],
  "forge:active": NAME,
  [`forge:${NAME}:history`]: history,
  [`forge:${NAME}:weights`]: {
    "Barbell Back Squat": 102.5, "Barbell Bench Press": 77.5,
    "Hex Bar Deadlift": 140, "Barbell Overhead Press": 50, "Power Clean": 70,
  },
  [`forge:${NAME}:reps`]: { "Barbell Back Squat": 5, "Barbell Bench Press": 5 },
  [`forge:${NAME}:streak`]: { count: 9, lastDate: history.at(-1).date },
  [`forge:${NAME}:bodyweight`]: { kg: 78.4, updatedAt: new Date().toISOString() },
  [`forge:${NAME}:focus`]: "Forged",
};

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({
  // 402x874 CSS at DPR 3 = the 1206x2622 the manifest declares. Shooting at
  // 1206 logical px instead produces a tablet-shaped layout, not a phone.
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  // Light is the shot: the app defaults to Auto (follow the device), and the
  // brand's primary canvas is the warm bone ground — the manifest's
  // background/theme colours. The earlier dark forcing predated the
  // light-dark() rework; it was never a time-of-day effect.
  colorScheme: "light",
});
const page = await ctx.newPage();
await page.addInitScript((s) => {
  for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
}, seed);

// The Lab, not the Profile screen: Profile is a settings list and reads flat
// in an install prompt. The Lab carries the charts.
for (const [path, file] of [["/", "home.png"], ["/performance", "lab.png"]]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500); // fades + hydration settle
  await page.screenshot({ path: OUT + file });
  console.log("captured", file);
}

await browser.close();
