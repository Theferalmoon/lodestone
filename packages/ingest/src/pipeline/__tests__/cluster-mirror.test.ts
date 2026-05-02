// SPDX-License-Identifier: Apache-2.0
// Tests for the §15 RED #3 fix: runPipeline must populate
// `symbols.cluster_id` after clustering so the §15 `context()` MCP tool
// (which reads the column directly) can surface cluster membership on a
// normal reindex.
//
// Pre-fix, the pipeline wrote symbols BEFORE clustering and persistClusters
// only wrote `cluster_members`/`clusters` — `symbols.cluster_id` stayed
// NULL. Unit fixtures (which seeded the column manually) passed; production
// indexes returned no cluster info from `context()`.
//
// Compliance: NIST 800-53 SI-7 (Software & Information Integrity — coherent
// reads after persist), AU-2; CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2; ISO 27001
// A.12.1.2; FedRAMP Mod SI-7; CIS v8 Control 4.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runPipeline } from "../index.js";
import type { EmbedderHandle } from "../../embed/runtime.js";
import { openReader, closeDb } from "../../store/sqlite.js";

const VECTOR_DIM = 768;

function mkEmbedder(): EmbedderHandle {
  // Deterministic embedder — every text → unit-length 768-d vector seeded
  // by a stable string hash so the pipeline runs without external models.
  const sample = (text: string): Float32Array => {
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      state = (state * 31 + text.charCodeAt(i)) >>> 0;
    }
    const out = new Float32Array(VECTOR_DIM);
    out[0] = (state % 1_000) / 1_000;
    out[1] = 1 - (out[0] ?? 0);
    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i++) norm += (out[i] ?? 0) * (out[i] ?? 0);
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) out[i] = (out[i] ?? 0) / norm;
    return out;
  };
  return {
    id: "nomic-text-v1.5",
    dim: VECTOR_DIM,
    maxBatch: 64,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => sample(t));
    },
    async dispose(): Promise<void> {
      /* no-op */
    },
  };
}

describe("§15 RED #3 — pipeline mirrors cluster_members onto symbols.cluster_id", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "lodestone-pipeline-cluster-"));
    mkdirSync(path.join(repoRoot, ".lodestone"), { recursive: true });
    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /**
   * Seed three TS files so the parser produces enough symbols + edges that
   * Louvain forms at least one non-singleton cluster. Two files are tightly
   * coupled (a.ts <-> b.ts) and a third is isolated (c.ts) — Louvain should
   * group a/b and put c on its own.
   */
  function seedRepo(): void {
    writeFileSync(
      path.join(repoRoot, "src", "a.ts"),
      `import { fb } from "./b";\nexport function fa(): number { return fb() + 1; }\nexport function fa2(): number { return fa(); }\n`,
    );
    writeFileSync(
      path.join(repoRoot, "src", "b.ts"),
      `import { fa } from "./a";\nexport function fb(): number { return 2; }\nexport function fb2(): number { return fa(); }\n`,
    );
    writeFileSync(
      path.join(repoRoot, "src", "c.ts"),
      `export function fc(): number { return 99; }\n`,
    );
  }

  it("after runPipeline, every symbol that landed in a cluster has symbols.cluster_id set to that cluster's id", async () => {
    seedRepo();
    const embedder = mkEmbedder();
    try {
      await runPipeline({
        repoRoot,
        embedder,
        embedderIdentity: { id: "nomic-text-v1.5", dim: VECTOR_DIM, quant: "fp32" },
        indexEpoch: 1,
      });
    } finally {
      await embedder.dispose();
    }

    const dbPath = path.join(repoRoot, ".lodestone", "lodestone.sqlite");
    const reader = openReader(dbPath);
    try {
      // For every (cluster_id, symbol_id) row in cluster_members, the
      // matching `symbols` row MUST carry the same cluster_id.
      const mismatches = reader
        .prepare(
          `SELECT cm.cluster_id AS expected, cm.symbol_id, s.cluster_id AS actual
             FROM cluster_members cm
             JOIN symbols s ON s.id = cm.symbol_id
            WHERE s.cluster_id IS NULL OR s.cluster_id != cm.cluster_id`,
        )
        .all() as Array<{ expected: string; symbol_id: string; actual: string | null }>;
      expect(mismatches).toEqual([]);

      // And there should be at least one symbol with a non-NULL cluster_id —
      // otherwise the test fixture isn't actually exercising the mirror.
      const populated = reader
        .prepare(
          `SELECT COUNT(*) AS c FROM symbols WHERE cluster_id IS NOT NULL`,
        )
        .get() as { c: number };
      expect(populated.c).toBeGreaterThan(0);
    } finally {
      closeDb(reader);
    }
  });

  it("symbols outside any cluster have symbols.cluster_id NULL (no spurious assignment)", async () => {
    seedRepo();
    const embedder = mkEmbedder();
    try {
      await runPipeline({
        repoRoot,
        embedder,
        embedderIdentity: { id: "nomic-text-v1.5", dim: VECTOR_DIM, quant: "fp32" },
        indexEpoch: 1,
      });
    } finally {
      await embedder.dispose();
    }

    const dbPath = path.join(repoRoot, ".lodestone", "lodestone.sqlite");
    const reader = openReader(dbPath);
    try {
      // Any symbol whose `id` does NOT appear in cluster_members must have
      // a NULL cluster_id. The mirror is "set from membership" not "set to
      // a default".
      const orphaned = reader
        .prepare(
          `SELECT s.id, s.cluster_id FROM symbols s
            WHERE s.cluster_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM cluster_members cm WHERE cm.symbol_id = s.id
              )`,
        )
        .all() as Array<{ id: string; cluster_id: string }>;
      expect(orphaned).toEqual([]);
    } finally {
      closeDb(reader);
    }
  });
});
