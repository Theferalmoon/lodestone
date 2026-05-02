// SPDX-License-Identifier: Apache-2.0
// Small fixture inputs for embedder tests. Kept in __fixtures__/ so the
// vitest coverage exclude pattern keeps them out of the threshold count.

export const SAMPLE_TEXTS = [
  "hello world",
  "the quick brown fox jumps over the lazy dog",
  "embedding ships should be reproducible",
  "src/auth.ts::User::login",
  "function ingestSymbol(s: Symbol): void { return; }",
] as const;

/** UTF-8 BOM-prefixed string — mirrors the parser test convention. */
export const SAMPLE_BOM = "﻿hello with bom";
