// SPDX-License-Identifier: Apache-2.0
// vitest config for @lodestone/cli.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        // bin/ entrypoint is exercised by bin.lodestone.test.ts via main()
        // imports — but the shebang wrapper itself is exercised in §20 e2e
        // when we spawn the actual binary. Excluded from coverage here.
        "src/bin/**",
        // runtime/ is a stub interface for §12/§13; exclude until those land.
        "src/runtime/**",
        // Pure barrel modules — only `export * from`/`export { … } from` lines.
        // Re-exports have no branches; v8 reports 0% which game-thresholds.
        // Excluding pure-barrel files keeps threshold meaningful.
        "src/index.ts",
        "src/config/schema.ts",
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
