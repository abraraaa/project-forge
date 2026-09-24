// Builds the coaching snapshot from the device's stores and puts it on the
// clipboard. Client-only. The one place a future "connected" path branches.
import { H, TS, F, P, W, BW } from "./storage.js";
import { WEEK } from "./programme.js";
import { buildCoachContext } from "./coach-context.js";

/** Whether an AI is connected for this profile. OAuth isn't built yet. */
export function coachConnected() {
  return false;
}

/** @param {string} profile @returns {Promise<"ok"|"fail">} */
export async function copyCoachContext(profile) {
  try {
    const text = buildCoachContext({
      history: H.get(profile),
      trainingState: TS.get(profile),
      focus: F.get(profile),
      mainLifts: P.getMainLifts(profile),
      week: W.get() || WEEK,
      bodyweightKg: BW.getKg(profile),
    });
    await navigator.clipboard.writeText(text);
    return "ok";
  } catch {
    return "fail";
  }
}
