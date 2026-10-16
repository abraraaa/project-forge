// The fonts the layout uses. next.config.mjs aliases this module to
// google.js or local.js at build time; this default keeps tooling that
// does not read the alias (tsc, eslint, vitest) pointed at google.js.
export { bodoni, familjen, spline } from "./google.js";
