// The trainer's CSV download (lib/trainer-export.js): RFC 4180 quoting, the
// pane's rules for kg and effort, the top set, the tops tier, set_by from the
// trainer's own changes, and a read of nothing outside the view's allow-list.
import { describe, it, expect } from "vitest";
import { csvFromView, csvField, exportFilename, EXPORT_COLUMNS, LOGGED_BY_TRAINER } from "../lib/trainer-export.js";
import { projectForTrainer as projectView, VIEW_KEYS } from "../lib/trainer-view.js";
import { PLAN_KEYS } from "../lib/trainer-plan.js";

/** RFC 4180, by hand: quoted fields may hold commas, doubled quotes and CRLF. */
function parse(text) {
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const records = (csv) => {
  const [comment, header, ...rest] = parse(csv);
  return { comment, header, rows: rest.map((r) => Object.fromEntries(EXPORT_COLUMNS.map((k, i) => [k, r[i]]))) };
};

const SQUAT = "Barbell Back Squat";
const session = (date, blocks, extra = {}) => ({ id: `${date}T12:00:00.000Z`, date, session: "strength-a", scheduledLetter: "A", readiness: "normal", blocks, ...extra });
const VIEW = {
  window: { from: "2026-04-20", trendFrom: "2025-10-05", to: "2026-10-05" },
  breaks: [], schedule: [],
  sessions: [
    session("2026-10-01", [
      { type: "main", exercises: [{ name: SQUAT, muscle: "Quads", loadType: "barbell", sets: [
        { weight: 100, reps: 5, rpe: 7, rir: null, loadType: "barbell" },
        { weight: 110, reps: 3, rpe: 9, rir: null, loadType: "barbell" },
        { weight: 110, reps: 3, rpe: 9.5, rir: null, loadType: "barbell" },
        { weight: null, reps: null, rpe: null, rir: null, loadType: null }, // never logged: not shown
      ] }] },
      { type: "accessory", exercises: [
        { name: "Pull-up", muscle: "Back", loadType: "bodyweight", sets: [
          { weight: 0, reps: 8, rpe: null, rir: 2, loadType: "bodyweight" },
          { weight: 5, reps: 6, rpe: null, rir: 1, loadType: "bodyweight" },
        ] },
        { name: 'Curl, "cable", high\nrope', muscle: "Biceps", loadType: "cable", sets: [{ weight: 20, reps: "12", rpe: null, rir: null, loadType: null }] },
        { name: "Plank", muscle: "Core", loadType: "bodyweight", sets: [{ weight: null, reps: "45s", rpe: null, rir: null, loadType: null }] },
      ] },
    ]),
  ],
  tops: [
    { id: "2026-01-10T12:00:00.000Z", date: "2026-01-10", readiness: "cooked", blocks: [{ type: "main", exercises: [{ name: SQUAT, sets: [{ weight: 95, reps: 5, rpe: 8 }] }] }] },
  ],
};
const opts = { name: "Cara", trainer: "Tia", date: "2026-10-05" };

describe("csvFromView", () => {
  it("opens with the comment line and the header, CRLF throughout", () => {
    const csv = csvFromView(VIEW, opts);
    expect(csv.split("\r\n")[0]).toBe("# Heatwayve export for Cara, 2026-10-05, shared with Tia");
    expect(csv.split("\r\n")[1]).toBe("date,session,block,lift,set,prescribed_reps,reps,kg,felt,top_set,set_by,logged_by");
    expect(csv.endsWith("\r\n")).toBe(true);
    // The only bare LF is the one inside the quoted name.
    expect(csv.replace(/\r\n/g, "").split("\n")).toHaveLength(2);
  });

  it("one row per shown set, then the tops tier as 'top' rows", () => {
    const { rows } = records(csvFromView(VIEW, opts));
    expect(rows.map((r) => [r.date, r.lift, r.set])).toEqual([
      ["2026-10-01", SQUAT, "1"], ["2026-10-01", SQUAT, "2"], ["2026-10-01", SQUAT, "3"],
      ["2026-10-01", "Pull-up", "1"], ["2026-10-01", "Pull-up", "2"],
      ["2026-10-01", 'Curl, "cable", high\nrope', "1"],
      ["2026-10-01", "Plank", "1"],
      ["2026-01-10", SQUAT, "top"],
    ]);
    expect(rows[0]).toMatchObject({ session: "A", block: "main", reps: "5", kg: "100", felt: "RPE 7", top_set: "0", set_by: "", prescribed_reps: "" });
    expect(rows[7]).toMatchObject({ session: "", block: "main", reps: "5", kg: "95", felt: "RPE 8", top_set: "1" });
  });

  it("quotes commas, quotes and line breaks in names (RFC 4180) and round-trips them", () => {
    const csv = csvFromView(VIEW, opts);
    expect(csv).toContain('"Curl, ""cable"", high\nrope"');
    expect(records(csv).rows[5].lift).toBe('Curl, "cable", high\nrope');
  });

  it("reps-only sets show blank kg; a bodyweight set shows only added kg; effort is RPE, else RIR", () => {
    const { rows } = records(csvFromView(VIEW, opts));
    expect(rows[3]).toMatchObject({ lift: "Pull-up", kg: "", reps: "8", felt: "RIR 2" });
    expect(rows[4]).toMatchObject({ lift: "Pull-up", kg: "5", reps: "6", felt: "RIR 1" });
    expect(rows[6]).toMatchObject({ lift: "Plank", kg: "", reps: "45s", felt: "" });
    expect(rows[5]).toMatchObject({ kg: "20", reps: "12", felt: "" });
  });

  it("marks the main lift's top set by the trend's rule (highest e1RM, first on ties); never an accessory", () => {
    const { rows } = records(csvFromView(VIEW, opts));
    expect(rows.slice(0, 3).map((r) => r.top_set)).toEqual(["0", "1", "0"]);
    expect(rows.slice(3, 7).every((r) => r.top_set === "0")).toBe(true);
  });

  it("set_by names the trainer where their change was trained at on that lift and date; a reps change fills prescribed_reps", () => {
    const plan = {
      lifts: [], mains: [], deload: null, week: [], budget: null,
      changes: [
        { id: "c1", kind: "weight", target: SQUAT, after: 110, status: "trained_yours", date: "2026-10-01" },
        { id: "c2", kind: "reps", target: SQUAT, after: 3, status: "trained_yours", date: "2026-10-01" },
        { id: "c3", kind: "weight", target: "Pull-up", after: 5, status: "waiting", date: "2026-10-01" }, // not trained at
        { id: "c4", kind: "weight", target: "Pull-up", after: 5, status: "trained_yours", date: "2026-09-01" }, // another day
      ],
    };
    const { rows } = records(csvFromView({ ...VIEW, plan }, opts));
    expect(rows.slice(0, 3).map((r) => [r.set_by, r.prescribed_reps])).toEqual([["Tia", "3"], ["Tia", "3"], ["Tia", "3"]]);
    expect(rows.slice(3).every((r) => r.set_by === "" && r.prescribed_reps === "")).toBe(true);
  });

  it("logged_by reads 'trainer' on every row of a session a trainer logged with the client, blank elsewhere; never a name", () => {
    expect(EXPORT_COLUMNS.slice(-2)).toEqual(["set_by", "logged_by"]);
    const coached = { ...VIEW, sessions: [{ ...VIEW.sessions[0], coached: true }, session("2026-09-29", VIEW.sessions[0].blocks)] };
    for (const o of [opts, { name: "Tia", trainer: null, date: "2026-10-05" }]) {
      const { rows } = records(csvFromView(coached, o));
      expect(rows.map((r) => [r.date, r.logged_by]).filter(([d]) => d === "2026-10-01").every(([, l]) => l === LOGGED_BY_TRAINER)).toBe(true);
      expect(rows.filter((r) => r.date !== "2026-10-01").every((r) => r.logged_by === "")).toBe(true);
      expect(rows.some((r) => r.date === "2026-09-29")).toBe(true);
    }
    expect(LOGGED_BY_TRAINER).toBe("trainer");
    expect(records(csvFromView(VIEW, opts)).rows.every((r) => r.logged_by === "")).toBe(true);
  });

  it("through the real projection: a kept trainer session reads 'trainer', and loggedBy's name and account never reach the file", () => {
    const rec = (id, extra = {}) => ({ id, date: "2026-10-01", readiness: "normal", session: "strength-a", scheduledLetter: "A",
      blocks: [{ type: "main", exercises: [{ name: SQUAT, loadType: "barbell", sets: [{ weight: 100, reps: 5, rpe: 8, loadType: "barbell" }] }] }], ...extra });
    const view = projectView({ history: [rec("2026-10-01T07:00:00.000Z", { loggedBy: { name: "Sam Price", accountId: "hwa_samaccount" } }),
      rec("2026-10-01T18:00:00.000Z")] }, { todayIso: "2026-10-05" });
    const csv = csvFromView(view, opts);
    expect(records(csv).rows.map((r) => r.logged_by)).toEqual(["trainer", ""]);
    expect(csv).not.toMatch(/Sam|hwa_|loggedBy/);
  });

  it("the trainer's own export names no one it is shared with", () => {
    const csv = csvFromView(VIEW, { name: "Tia", trainer: null, date: "2026-10-05" });
    expect(csv.split("\r\n")[0]).toBe("# Heatwayve export for Tia, 2026-10-05");
  });

  it("names in the comment line stay on one line and never start a formula", () => {
    const csv = csvFromView({ sessions: [], tops: [] }, { name: "=cmd,\"x\"\r\ny", trainer: "@t", date: "2026-10-05" });
    expect(csv).toBe("# Heatwayve export for '=cmd x y, 2026-10-05, shared with '@t\r\ndate,session,block,lift,set,prescribed_reps,reps,kg,felt,top_set,set_by,logged_by\r\n");
  });

  it("an empty or missing view is the header alone", () => {
    for (const v of [null, undefined, {}, { sessions: "x", tops: 3 }]) {
      expect(records(csvFromView(v, opts)).rows).toEqual([]);
    }
  });

  it("reads nothing outside the view's allow-list", () => {
    const allowed = new Set([...Object.values(VIEW_KEYS).flat(), ...Object.values(PLAN_KEYS).flat()]);
    const seen = new Set();
    const watch = (o) => (o && typeof o === "object" ? new Proxy(o, {
      get(t, k) {
        if (typeof k === "string" && !Array.isArray(t)) seen.add(k);
        return watch(t[k]);
      },
    }) : o);
    const plan = { changes: [{ id: "c1", kind: "weight", target: SQUAT, after: 110, status: "trained_yours", date: "2026-10-01" }] };
    csvFromView(watch({ ...VIEW, plan }), opts);
    expect(seen.size).toBeGreaterThan(5);
    expect([...seen].filter((k) => !allowed.has(k))).toEqual([]);
  });

  it("canary: fields planted on the stored meta and records never reach the file", () => {
    const meta = {
      bodyweight: 777.11, bodyweightLog: [{ date: "2026-10-01", kg: 777.22 }], photos: ["SENTINEL-photo.jpg"],
      displayName: "SENTINEL-displayName", sleep: 777.33, notes: "SENTINEL-notes",
    };
    const history = [{
      id: "2026-10-01T07:13:42.000Z", date: "2026-10-01", session: "strength-a", scheduledLetter: "A", readiness: "cooked",
      readinessReason: "SENTINEL-reason", bodyweight: 777.44, hoursSlept: 777.55, notes: "SENTINEL-notes", startedAt: 1777777777777,
      blocks: [{ type: "main", exercises: [{ name: SQUAT, loadType: "barbell", sets: [
        { weight: 100, reps: 5, rpe: 8, loadType: "barbell", bodyweightUsed: 81.37, effectiveLoad: 778.11, est1rm: 778.22, volume: 778.33 },
      ] }, { name: "Pull-up", loadType: "bodyweight", sets: [
        { weight: 10, reps: 6, rpe: 9, loadType: "bodyweight", bodyweightUsed: 81.37, effectiveLoad: 91.37, est1rm: 778.44 },
      ] }] }],
    }];
    const csv = csvFromView(projectView({ meta, history }, { todayIso: "2026-10-05" }), opts);
    expect(csv).toContain(SQUAT);
    for (const f of ["SENTINEL", "777.", "778.", "81.37", "91.37", "07:13:42", "1777777777777", "bodyweight", "photo", "est1rm", "cooked"]) {
      expect(csv, f).not.toContain(f);
    }
  });
});

describe("csvField", () => {
  it("quotes only when needed, doubles quotes, and never starts a formula", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("+1,2")).toBe("\"'+1,2\"");
    expect(csvField(-2.5)).toBe("-2.5");
    expect(csvField(null)).toBe("");
    expect(csvField(NaN)).toBe("");
  });
});

describe("exportFilename", () => {
  it("is ASCII: the handle, else the fallback label, and the date", () => {
    expect(exportFilename("cara", "", "2026-10-05")).toBe("heatwayve-cara-2026-10-05.csv");
    expect(exportFilename("ＳＡＭ", "", "2026-10-05")).toBe("heatwayve-sam-2026-10-05.csv");
    expect(exportFilename("名前", "", "2026-10-05")).toBe("heatwayve-client-2026-10-05.csv");
    expect(exportFilename("名前", "me", "2026-10-05")).toBe("heatwayve-me-2026-10-05.csv");
    expect(exportFilename(null, '"; x=1', "bad")).toBe("heatwayve-x-1-export.csv");
    expect(exportFilename(null, "", "2026-10-05")).toBe("heatwayve-client-2026-10-05.csv");
  });
});
