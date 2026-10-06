import { defineConfig } from "vitest/config";

// Test discovery and per-file behavior are left to vitest defaults; this file
// only defines the v3 coverage gate (quick win C) so CI can enforce a
// "do-not-decrease" floor. `npm test` runs without coverage — enable it via
// `npm run test:coverage` or `vitest run --coverage`.
//
// Thresholds are set just below the measured baseline (statements 87%,
// branches 77%, functions 91%, lines 88%) so the gate fails only when a
// change erodes coverage, not because of an aspirational target.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "html"],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 88,
        lines: 85,
      },
    },
  },
});
