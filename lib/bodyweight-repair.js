// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/bodyweight-repair.js — DRY RUN ONLY (wipe protocol, step 1).
// Bodyweight movements keep ADDED load wherever a weight is stored. Before
// 2026-09-25 two writers stored bodyweight + added instead, and an unloaded
// session never overwrote it, so a pull-up could carry "79.8 kg added"
// (= the lifter's bodyweight). This lists what a repair WOULD set, from the
// last logged session of each lift. It changes nothing; applying it needs a
// separate, explicit switch after the owner has read the list on a real
// device. The fixed writers heal each lift on its next session regardless.

import { isBodyweightMovement } from "./lift-translations.js";

/**
 * @param {{ weights?: Record<string, any>, trainingState?: any, history?: any[] }} input
 * @returns {{ lift: string, field: "working weight" | "lift state" | "pre-deload", stored: number, wouldSet: number, from: string }[]}
 */
export function staleAddedLoads({ weights = {}, trainingState = null, history = [] } = {}) {
  /** @type {Record<string, { date: string, id: string, added: number }>} */
  const last = {};
  for (const rec of history || []) {
    for (const ex of (rec?.blocks || []).flatMap((b) => b?.exercises || [])) {
      const sets = ex?.sets || [];
      const loadType = ex?.loadType ?? sets.find((s) => s?.loadType)?.loadType ?? null;
      if (!ex?.name || !sets.length || !isBodyweightMovement(loadType)) continue;
      const key = `${rec.date || ""}|${rec.id || ""}`;
      const prev = last[ex.name];
      if (prev && `${prev.date}|${prev.id}` >= key) continue;
      const added = Math.max(0, ...sets.map((s) => (Number.isFinite(s?.weight) ? s.weight : 0)));
      last[ex.name] = { date: rec.date || "", id: rec.id || "", added };
    }
  }
  /** @type {{ lift: string, field: "working weight" | "lift state" | "pre-deload", stored: number, wouldSet: number, from: string }[]} */
  const out = [];
  const differs = (v, want) => Number.isFinite(v) && Math.abs(v - want) > 0.01;
  for (const [lift, l] of Object.entries(last)) {
    if (differs(weights?.[lift], l.added)) out.push({ lift, field: "working weight", stored: weights[lift], wouldSet: l.added, from: l.date });
    const st = trainingState?.lifts?.[lift];
    if (differs(st?.currentWeight, l.added)) out.push({ lift, field: "lift state", stored: st.currentWeight, wouldSet: l.added, from: l.date });
    if (st?.preDeloadWeight != null && differs(st.preDeloadWeight, l.added) && st.preDeloadWeight > l.added + 20) {
      out.push({ lift, field: "pre-deload", stored: st.preDeloadWeight, wouldSet: l.added, from: l.date });
    }
  }
  return out.sort((a, b) => a.lift.localeCompare(b.lift) || a.field.localeCompare(b.field));
}
