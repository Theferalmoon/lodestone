// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    // E2E specs install + ingest + exercise every MCP tool — keep timeouts
    // generous so a slow CI runner doesn't false-fail. The orchestrator
    // controls its own per-step budgets internally.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Single fork: the orchestrator mutates env vars (LODESTONE_CWD, OFFLINE)
    // and patches global network primitives; concurrent specs would race.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Coverage off by default — e2e is a single integration story; coverage
    // belongs in the per-package unit suites.
    reporters: ["verbose"],
  },
});
