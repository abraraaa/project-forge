# Internal notes live outside this repo

**Rule, set 2026-07-27, widened 2026-08-04: design rationale, review findings
and architecture narration do not get committed here.**

This repository is public on purpose — the training science should be open to
inspection. But the *reasoning* is a different asset. The sync/merge algebra and
the progression engine are the product; a narrated account of how they work, what
we tried, and where they're thin is a blueprint, not a contribution. The same
goes for review findings, which double as a map of where to push.

## Where things go now

| Material | Home |
|---|---|
| Audit findings, review notes, threat/trust analysis | Google Drive — **Heatwayve — Internal Notes** |
| Design rationale, "why we built it this way" essays | Same |
| Architecture / sync / platform-research docs | Same (moved 2026-08-04; the repo copy of frontend-audit.md was finally deleted 2026-09-04 — git history holds both) |
| The live to-do / parking list, roadmap | Same |
| Code-level intent | Comments at the site, stating the *invariant* being protected — not the failure mode that motivated it |

## How to write in this repo

- **Commits and PRs describe the change, not the reasoning trail.** "Harden the
  request-size guard on bug intake" — not a walkthrough of what was unbounded,
  how far, and what that let you do.
- **Tests pin the invariant, not the attack.** `it("rejects an oversized body
  before parse")` is the contract. A comment reconstructing the exploit is a
  recipe.
- **Never enumerate what's still open.** A public list of known-weak seams is
  the single most useful document an attacker can find. Open items live in
  Drive, all of them.
- **Feature work stays expressive.** This restraint is for vulnerability
  handling and core-IP rationale. Copy, UI, product decisions — write those with
  the usual voice.

If a note feels like it belongs in the repo but explains *why the engine works*,
it belongs in Drive.
