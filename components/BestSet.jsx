// components/BestSet.jsx — a lift's best set in the Lab's BestLine wording:
// "102.5 kg × 5", "bodyweight + 10 kg × 6", "12 reps". Numerals mono.

import { T } from "@/lib/tokens";
import { isBodyweightMovement } from "@/lib/lift-translations";

/** @param {{ best: { loadType?: string, weight?: number|null, reps?: any } }} props */
export default function BestSet({ best }) {
  const n = (/** @type {any} */ v) => <span style={{fontFamily:T.measured}}>{v}</span>;
  return best.loadType === "bodyweight"
    ? (typeof best.reps === "number" ? <>{n(best.reps)} reps</> : n(best.reps))
    : isBodyweightMovement(best.loadType)
    ? <>bodyweight + {n(best.weight)} kg × {n(best.reps)}</>
    : <>{n(best.weight)} kg × {n(best.reps)}</>;
}
