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
      // eslint-config-next does not extend eslint:recommended, so this was
      // off. A duplicate currentRepRange key sat in the lift-state literal
      // where the later one silently won — the kind of thing that reads fine
      // and quietly discards the value above it. Turned on after it bit.
      "no-dupe-keys": "error",
    },
  },
  {
    // The live service worker runs in worker scope, not a window: its own
    // globals on top of the browser set. Same rules as the app.
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        importScripts: "readonly",
        clients: "readonly",
        registration: "readonly",
        skipWaiting: "readonly",
        serviceWorker: "readonly",
        Client: "readonly",
        Clients: "readonly",
        WindowClient: "readonly",
        ExtendableEvent: "readonly",
        ExtendableMessageEvent: "readonly",
        FetchEvent: "readonly",
        InstallEvent: "readonly",
        ServiceWorkerGlobalScope: "readonly",
        WorkerGlobalScope: "readonly",
      },
    },
  },
  {
    // public/ is served as-is; only the hand-written service worker is
    // linted. The generated precache manifest (sw-precache.js) stays out.
    ignores: [".next/**", "node_modules/**", "public/**/*", "!public/sw.js", ".claude/**"],
  },
];

export default eslintConfig;
