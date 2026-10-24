// lib/session-kg.js
// The kg a logged set is saved at, in one place: the host saves it and the
// round recap shows it, so the recap never promises a number the save
// disagrees with. A pure bodyweight set logs only the lifter's own added load
// (null when none); every other lift logs the weight the session plans for
// it (W, else the planned start).
import { getLoadType, addedLoadFor } from "./lift-translations.js";

/**
 * @param {any} ex  the resolved exercise
 * @param {{ addedLoads: Record<string, any>, planWeight: (ex: any) => number | null }} by
 * @returns {number | null}
 */
export function savedKgFor(ex, { addedLoads, planWeight }) {
  if (!ex) return null;
  return getLoadType(ex) === "bodyweight" ? addedLoadFor(addedLoads, ex.name) : planWeight(ex);
}
