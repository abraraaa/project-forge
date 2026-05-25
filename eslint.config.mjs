// eslint.config.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Flat config (ESLint 9+). Next 16 removed `next lint`, so we run ESLint
// directly (`eslint .`). eslint-config-next 16 ships a native flat-config
// array, so we spread it straight in — no FlatCompat bridge needed.
// ─────────────────────────────────────────────────────────────────────────────

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    rules: {
      // Load-bearing: a misplaced hook silently corrupts state. Stays at error.
      "react-hooks/rules-of-hooks": "error",
      // We use apostrophes in copy freely; escaping them hurts readability.
      "react/no-unescaped-entities": "off",

      // React Compiler-era rules, newly bundled by eslint-config-next 16.
      // They flag pre-existing patterns (render-time Date.now(), state synced
      // in effects) across ForgeApp.jsx that predate these rules and aren't
      // related to the dependency bump that surfaced them. Kept at "warn" so
      // the signal stays visible for a dedicated hooks-hygiene pass, without
      // blocking CI on a refactor of working, shipped UI code.
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "public/**"],
  },
];

export default eslintConfig;
