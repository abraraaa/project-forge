// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/volume-targets.js
// The per-muscle weekly landmarks, on their own so the programme layer can
// read them without importing the audit (which imports the programme).

// Weekly volume landmarks (weighted sets per week), from the project reference
// data (Israetel/Nuckols/Helms-derived). The "Shoulders (per head)" row applies
// independently to Front / Side / Rear delts. Forearms has no landmark (it's a
// stabiliser we track but don't programme volume for) and is reported untargeted.
export const VOLUME_TARGETS = {
  Quads:         { mev: 8,  mav: 18, mrv: 22 },
  Hamstrings:    { mev: 6,  mav: 12, mrv: 16 },
  Glutes:        { mev: 4,  mav: 12, mrv: 16 },
  Chest:         { mev: 8,  mav: 16, mrv: 20 },
  // Back split (stage 3): Lats + Upper Back carry the old Back volume as
  // banded targets (panel-adjudicated starting landmarks, RP-consistent).
  // Erectors is a fatigue CEILING — mev 0, same doctrine as Traps: warn
  // when deadlift-heavy weeks stack axial load, never nag a shortfall.
  Lats:          { mev: 6,  mav: 14, mrv: 22 },
  "Upper Back":  { mev: 6,  mav: 16, mrv: 22 },
  Erectors:      { mev: 0,  mav: 6,  mrv: 12 },
  // Traps: mev 0, like Core — the reference data treats direct trap volume
  // as optional (deads/rows/carries deliver plenty indirectly), so the row
  // must flag EXCESS without ever nagging a shortfall nobody should chase.
  Traps:         { mev: 0,  mav: 12, mrv: 20 },
  "Front Delts": { mev: 6,  mav: 12, mrv: 16 },
  "Side Delts":  { mev: 6,  mav: 12, mrv: 16 },
  "Rear Delts":  { mev: 6,  mav: 12, mrv: 16 },
  Biceps:        { mev: 5,  mav: 14, mrv: 20 },
  Triceps:       { mev: 6,  mav: 14, mrv: 18 },
  Calves:        { mev: 6,  mav: 12, mrv: 16 },
  Core:          { mev: 0,  mav: 16, mrv: 25 },
};
