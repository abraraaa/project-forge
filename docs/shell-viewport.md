# Shell-owns-the-viewport — design note (Phase 2 keystone)

**Status: DESIGN FOR REVIEW — no code ships until this note is approved.**
Written 2026-07-11. Companion to the roadmap in `parked.md` (Phase 2).

## 1 · The problem, named

Every screen negotiates raw with the viewport. Each carries its own guesses
about insets, heights, and chrome: the session screen does
`calc(100dvh − env(safe-area-inset-top))`, sheets carry their own safe-area
padding and (since the detached-card fork) two `!important` overrides, the
library pages do `max(52px, calc(env(safe-area-inset-top) + 12px))`, Home
relies on `.forge-page`'s standalone-only padding. ~30 of our last 200 PRs
were symptoms of this missing contract. The chin saga was its most expensive
lesson: the fix wasn't better negotiation, it was **assigning the edge to the
layer that owns it**. This note extends that principle from edges to the
whole viewport.

## 2 · The contract

**`.forge-page` becomes the single owner of viewport and chrome accounting.**

- The shell knows: the viewport height, the safe-area insets, the display
  mode, and (via the sheet grammar) who owns each chrome edge.
- Screens know: nothing about any of that. A screen declares its *shape*:
  - **`flow`** (default) — top-anchored, scrolls. Home, Profile, Lab,
    library, diag. No changes to these screens at all.
  - **`fill`** — occupies exactly the available viewport, no scroll in
    steady state, may pin content to its bottom. Session (live screen) is
    today's only member.
- After this lands, `env(safe-area-inset-*)` and `vh`/`dvh` in height maths
  are **forbidden outside the shell and the sheet class** (grep-enforceable
  convention, noted in CLAUDE.md house mechanics).

## 3 · Mechanism

`.forge-page` becomes a flex column with a definite height; `fill` screens
say `flex: 1 1 auto; min-height: 0` (one utility class, `.forge-fill`);
`flow` screens are unchanged flex items that size to content and scroll the
root as today.

**The height unit is the hard part, and a recorded scar constrains it**
(globals.css, from device): *`100dvh` reports wrong values on PWA cold start
until the device rotates; `100vh` works from launch.* And in browser, `100vh`
overshoots under the dynamic toolbar. So the shell's height is layered:

```css
.forge-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;                      /* floor: correct in PWA from cold
                                             launch (the recorded scar) */
}
@media not (display-mode: standalone) {
  .forge-page { min-height: 100dvh; }     /* browser: toolbar-aware; the
                                             cold-start dvh scar is a PWA
                                             phenomenon */
}
@supports (height: stretch) {
  .forge-page { min-height: stretch; }    /* Safari 27: correct by
                                             construction in both modes;
                                             users are on the beta */
}
```

Open verification question for the device pass: does `stretch` resolve
correctly on PWA cold start (the dvh failure case)? If yes, the ladder
collapses to `stretch` + `100vh` floor. If it inherits dvh's cold-start bug,
the standalone branch pins to `100vh` permanently and only browser gets
`stretch`.

Safe-area: stays exactly where it is today (`padding-top` on `.forge-page`
in standalone) — inside the flex column's box, so `fill` screens no longer
need to know it exists. **The session screen deletes its
`calc(100dvh − inset)` root and its `100dvh` assumptions entirely** — it
becomes `.forge-fill` with the same three-zone internals.

## 4 · What changes, file by file

| File | Change |
|---|---|
| `app/globals.css` | `.forge-page` flex column + height ladder; new `.forge-fill`; sheet chrome moves fully into `.forge-sheet-ground` (kills the two `!important`s) |
| `components/SessionScreen.jsx` | root: `calc(100dvh−inset)` div → `className="forge-fill"`; spacers unchanged |
| 17 sheet roots | delete inline `borderRadius`/`maxWidth` (now class-owned) — mechanical, one line each |
| Everything else | **no changes** — `flow` is the default and matches current behaviour |

## 5 · Blast radius & risk register

The shell wraps every route, so the risk isn't the diff — it's the scars.
Each of these was device-won and must be re-verified explicitly:

1. **Chrome sampling** (html/body `#1D1A19`; `.forge-page` must not become
   the sampled element or gain paint that changes zone tints).
2. **Natural root scroller** (no `overflow` on html/body; `.forge-page`
   keeps `overflow-x: clip` only — flex must not introduce a scroll
   container).
3. **Grain stacking** (`isolation: isolate` + negative-z grain child —
   flex on the same element must not change paint order; grain is
   absolute, out of flow, unaffected in principle — verify in practice).
4. **VT boundary sits inside `.forge-page`** — route content becomes a
   flex item; the boundary element needs `width: 100%` semantics preserved.
5. **Desktop ambient backdrop** (≥768px gradients on `.forge-page`) —
   pure paint, but verify.
6. **Margin collapsing**: flex items don't margin-collapse with the
   container. Route roots use padding, not margins — believed inert;
   verify Home top spacing pixel-identical.
7. **Sheets**: removing inline chrome must land in the same PR as the class
   takeover, or sheets briefly lose radius (the first-paint class-race the
   bodyweight one-off hinted at — moot once inline styles stop competing).

## 6 · Acceptance criteria

- Screenshot matrix pixel-parity for every `flow` screen (see §7).
- Session (`fill`): Log button above the home indicator, no scroll, PWA
  cold launch included (the dvh scar's specific failure case).
- Short viewports (split-screen ~500px): `fill` degrades to scroll,
  nothing clipped; `flow` unaffected.
- No child of the shell references `env(safe-area-inset-*)` or `vh` for
  height maths (grep gate).
- Fold-crease avoidance: **out of scope** (product decision, recorded).

## 7 · Verification plan

1. **Baseline BEFORE any change**: screenshot matrix — every route
   {Home, Session×3 states, Profile, Lab, library index+entry, diag-sync}
   × {browser, PWA} × {toolbar expanded/minimised where applicable}.
   Chromium harness for geometry; device pass for chrome behaviour.
2. Build on a branch; same matrix after; visual diff reviewed together.
3. Explicit scar checklist (§5) walked one by one on device.
4. Soak: no other PRs ride along; the shell ships alone.

## 8 · Sequencing

1. This note approved (amendments welcome — §3's unit ladder is the main
   open question).
2. Baseline matrix captured and committed (so "after" has an anchor).
3. Shell PR (globals + session root + sheet chrome takeover).
4. Device pass against §6; fixes only within the PR's scope.
5. Then Phase 3 (intimacy pass) builds on the new contract.
