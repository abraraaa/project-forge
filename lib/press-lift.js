// @ts-check
// lib/press-lift.js
// Pointer tracking for the commit-surface press lift (.forge-lift, globals.css).
// NB: "bloom" already means the effort-ramp colour transition (§13); this is
// a different thing and deliberately does not borrow the name.
// Spread onto a button; the bloom then centres on the contact point rather than
// the element. Sheets must not use this — they get haptics only.

/** @param {{ currentTarget: HTMLElement, clientX: number, clientY: number }} e */
function track(e) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--x", `${e.clientX - r.left}px`);
  el.style.setProperty("--y", `${e.clientY - r.top}px`);
}

/** Props to spread onto a .forge-lift element. */
export const pressLiftHandlers = {
  onPointerDown: track,
  onPointerMove: /** @param {any} e */ (e) => { if (e.pressure > 0 || e.buttons) track(e); },
};
