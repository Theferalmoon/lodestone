// SPDX-License-Identifier: Apache-2.0
// vitest config for @lodestone/mcp-server.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        // Pure barrel re-exports — no branches.
        "src/index.ts",
        "src/tools/index.ts",
        // server.ts wires stdio transport + signal handlers; partially covered
        // by tools-registration.test.ts (the registration loop) but the
        // process.on(SIGINT) main() is exercised in §20 e2e.
        "src/server.ts",
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
        statements: 75,
      },
    },
  },
});
