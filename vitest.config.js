import { defineConfig } from "vitest/config";
import path from "path";

// Default environment is node — keeps the existing 327 pure-library tests
// fast. Per-file `// @vitest-environment jsdom` opts component tests into
// the DOM. Avoids paying jsdom's startup cost on every unit test.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve("."),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.{js,jsx}"],
    setupFiles: ["tests/setup.js"],
  },
});
