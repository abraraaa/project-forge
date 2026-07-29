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

const LETTERS = ["a", "b", "c"];
const LIFTS = {
  a: [["Barbell Back Squat", 102.5, 5], ["Barbell Bench Press", 77.5, 5]],
  b: [["Hex Bar Deadlift", 140, 5], ["Barbell Overhead Press", 50, 5]],
  c: [["Power Clean", 70, 3]],
};

// Nine sessions on a ~3-day cadence, so the streak pill reads healthy rather
// than advertising an empty account in the install prompt.
const history = [];
const cursor = new Date();
cursor.setDate(cursor.getDate() - 2);
for (let i = 0; i < 9; i++) {
  const letter = LETTERS[i % 3];
  const date = iso(cursor);
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
      exercises: LIFTS[letter].map(([name, weight, reps]) => ({
        name,
        loadType: "total",
        sets: [
          { weight, reps, rpe: "normal" },
          { weight, reps, rpe: "normal" },
          { weight, reps: reps - 1, rpe: "cooked" },
        ],
      })),
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
  colorScheme: "dark",
});
const page = await ctx.newPage();
await page.addInitScript((s) => {
  for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
}, seed);

for (const [path, file] of [["/", "home.png"], ["/profile", "profile.png"]]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500); // fades + hydration settle
  await page.screenshot({ path: OUT + file });
  console.log("captured", file);
}

await browser.close();
