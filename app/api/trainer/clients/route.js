import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { dbPrimaryHandle } from "@/lib/identity-store";
import { dbTrainerGrants, dbRemoveByTrainer, dbRosterSignals } from "@/lib/trainer-store";
import { dbRosterWaiting } from "@/lib/trainer-changes-store";
import { publicName, rosterSignal } from "@/lib/trainer-view";
import { durationMs, trainerDay } from "@/lib/server-time";
import { trainerGate, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { dbMarkSeen } from "@/lib/notices";
import { serverError } from "@/lib/api-errors";
import { shareCovers } from "@/lib/trainer-terms";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

const DAY_MS = durationMs({ days: 1 });
const LABEL = "trainer-clients";

/** Carry the gate's daily slide, if any, on whatever the route answers. */
const slid = (gate, res) => (gate.refresh ? setTrainerCookie(res, gate.refresh) : res);
const byName = (a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name));

/**
 * Each listed client's roster signal, or null when the roster log (or the read
 * after it) fails: no signal is ever shown without its look being logged.
 * @param {string} me
 * @param {string[]} refs
 * @param {unknown} rawToday  the trainer device's date
 * @param {number} [now]
 */
async function roster(me, refs, rawToday, now = Date.now()) {
  const today = trainerDay(rawToday, now);
  try {
    const rows = await dbRosterSignals(me, refs, { today, now });
    if (!rows) return null;
    return new Map([...rows].map(([ref, row]) => [ref, rosterSignal(row, today)]));
  } catch (e) {
    serverError(e, { label: `${LABEL}-roster` }); // logged; the list still answers
    return null;
  }
}

/**
 * What is waiting on each client with changes on or a consent that covers
 * coached sessions (dbRosterWaiting), zeros included; null when the read
 * fails. Other clients are absent. A session stays on the client's phone
 * after changes stop, and their pane still shows it, so the count does too.
 * @param {string} me
 * @param {{ ref: string, edits: boolean, consentVersion: string | null }[]} grants
 */
async function waitingFor(me, grants) {
  const refs = grants.filter((x) => x.edits === true || shareCovers(x.consentVersion, "session")).map((x) => x.ref);
  if (!refs.length) return new Map();
  try {
    const rows = await dbRosterWaiting(me, refs);
    if (!rows) return null;
    return new Map(refs.map((ref) => [ref, rows.get(ref) ?? { changes: 0, sessions: 0, kept: null }]));
  } catch (e) {
    serverError(e, { label: `${LABEL}-waiting` }); // logged; the list still answers
    return null;
  }
}

// POST /api/trainer/clients
//   { today }        -> { me: { name }, clients: [{ ref, name, since, lastLooked, signal, waiting }] }, by name.
//                       signal is the roster line (rosterSignal). It is read only after a
//                       roster look is logged on every listed grant; if that log can't be
//                       written, every signal is null and the list is names and dates only.
//                       waiting: { changes, sessions } for a client with changes on or a
//                       consent that covers coached sessions, read after the roster look
//                       like the signal: the trainer's changes the pane lists as waiting
//                       (none while changes are off) and their sessions on the client's
//                       phone. null for any other client, or when either read fails.
//                       kept: { letter, at } the latest session of this trainer's the
//                       client kept (from the same read: the row's outcome 'kept', its
//                       target's letter and applied_at), else null; the roster says
//                       so on the day it was kept, on the trainer's own calendar.
//                       Once the signals are read, the clients notice is marked seen
//                       (dbMarkSeen, an overwrite in place of the trainer's one 'clients' mark).
//   { remove: ref }  -> { ok }. Ends that grant by UPDATE revoked_at, revoked_by 'trainer'.
// POST keeps grant ids out of URLs and logs.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const removing = !!body && typeof body === "object" && "remove" in body;
  const [bucket, perMinute] = removing ? ["trainer-clients-remove", 20] : [LABEL, 30];
  const limited = rateLimit(request, bucket, perMinute);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    const me = g.identity.accountId;

    if (removing) {
      const ref = typeof body.remove === "string" && body.remove.length <= 128 ? body.remove : null;
      const ended = ref ? await dbRemoveByTrainer(ref, me) : false;
      return slid(g, ended ? json({ ok: true }) : json({ error: "Not shared with you now." }, 404));
    }

    const shared = await rateLimitShared(request, LABEL, 600, { windowMs: DAY_MS, id: me });
    if (shared) return slid(g, noStore(shared));
    const grants = (await dbTrainerGrants(me)) ?? [];
    const at = Date.now();
    const signals = grants.length ? await roster(me, grants.map((x) => x.ref), body?.today, at) : null;
    const waiting = signals ? await waitingFor(me, grants) : null;
    // Only after the roster was logged and read; marked at the read's start, so a
    // session that arrives mid-read still lights the dot. A failed mark never fails the list.
    if (signals) {
      try {
        await dbMarkSeen(me, "clients", at);
      } catch (e) {
        serverError(e, { label: `${LABEL}-seen` });
      }
    }
    const clients = grants
      .map(({ ref, name, since, lastLooked }) => {
        const w = waiting?.get(ref) ?? null;
        return {
          ref, name, since, lastLooked, signal: signals?.get(ref) ?? null,
          waiting: w ? { changes: w.changes, sessions: w.sessions } : null, kept: w?.kept ?? null,
        };
      })
      .sort(byName);
    return slid(g, json({ me: { name: publicName(await dbPrimaryHandle(me)) }, clients }));
  } catch (e) {
    return noStore(serverError(e, { label: LABEL }));
  }
}
