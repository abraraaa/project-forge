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
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "public/**", ".claude/**"],
  },
];

export default eslintConfig;
