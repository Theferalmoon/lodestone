// SPDX-License-Identifier: Apache-2.0
// Root vitest config — runs the bootstrap test suite at the repo root.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
