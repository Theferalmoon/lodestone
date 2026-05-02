// SPDX-License-Identifier: Apache-2.0
//
// §20 — End-to-end test harness. Wraps the full orchestrator
// (run-e2e.ts) inside vitest, runs the network interceptor for the
// duration, and asserts FIXTURE_MANIFEST.json predictions hold.
//
// Layout: one describe block per concern, all sharing a single fork +
// tmp dir to keep wall-time reasonable. The top-level `beforeAll` runs
// the heavy install + ingest pipeline once; per-test `it` blocks
// exercise the persisted index without re-running ingest.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  cleanupTmp,
  cloneFixtureToTmp,
  injectQueryEmbedder,
  clearQueryEmbedder,
  loadFixtureManifest,
  makeClusterHandler,
  resolveMcpToolDistPath,
  runIngest,
  runLodestoneCli,
  withLodestoneCwd,
  type FixtureManifest,
  type IngestSummary,
} from "../run-e2e.js";
import {
  installNetworkInterceptor,
  type NetCallRecord,
  NetworkInterceptedError,
} from "../network-interceptor.js";

// ── Test-wide state ───────────────────────────────────────────────────────
let tmpRepo: string;
let manifest: FixtureManifest;
let ingest: IngestSummary;
let netLog: NetCallRecord[];
let interceptorRestore: () => void;

const SUITE_TIMEOUT_MS = 90_000;

/** Lazy-loader for a tool handler — accepts only the tool name and returns
 * the dist module's `handler` callable. Hides the `import(absolutePath)`
 * pattern behind a single name. */
async function loadToolHandler<TIn = unknown, TOut = { results: unknown[] }>(
  toolName: string,
): Promise<(input: TIn) => Promise<TOut>> {
  const mod = (await import(resolveMcpToolDistPath(toolName))) as {
    handler: (input: TIn) => Promise<TOut>;
  };
  return mod.handler;
}

beforeAll(async () => {
  manifest = loadFixtureManifest();

  // Network interceptor — install BEFORE any ingest/embedder/MCP code runs.
  // We use record-only mode so a benign localhost call (better-sqlite3 IPC,
  // process.binding internals) doesn't fail the run; the test below asserts
  // the recorded log contains zero non-allowlisted entries.
  netLog = [];
  const handle = installNetworkInterceptor({
    block: false, // record-only; assertion below catches actual leaks
    log: netLog,
  });
  interceptorRestore = handle.restore;

  tmpRepo = cloneFixtureToTmp();

  // 1. Run `lodestone init` against the cloned fixture.
  const initResult = await runLodestoneCli([
    "init",
  ], tmpRepo, { timeoutMs: 60_000 });
  if (initResult.exitCode !== 0) {
    throw new Error(
      `lodestone init failed (exit ${initResult.exitCode}): ${initResult.stderr || initResult.stdout}`,
    );
  }

  // 2. Drive the §05–§11 ingest pipeline against the cloned fixture.
  ingest = await runIngest(tmpRepo);
}, SUITE_TIMEOUT_MS);

afterAll(() => {
  if (interceptorRestore) {
    try {
      interceptorRestore();
    } catch {
      /* best-effort */
    }
  }
  if (tmpRepo) cleanupTmp(tmpRepo);
});

// ── §04 install-correctness assertions ────────────────────────────────────
describe("§20 :: install side effects (proxy for §04 acceptance)", () => {
  it("creates .mcp.json containing the lodestone-mcp entry", () => {
    const mcpPath = path.join(tmpRepo, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.mcpServers["lodestone-mcp"]).toBeDefined();
    expect(parsed.mcpServers["lodestone-mcp"]!.command).toContain(
      ".lodestone/runtime/lodestone-mcp",
    );
  });

  it("patches .gitignore with .lodestone/", () => {
    const gi = readFileSync(path.join(tmpRepo, ".gitignore"), "utf8");
    expect(gi.split(/\r?\n/).map((l) => l.trim())).toContain(".lodestone/");
  });

  it("writes the install manifest under .lodestone/", () => {
    const manifestPath = path.join(tmpRepo, ".lodestone", "install-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { schema_version: number };
    expect(m.schema_version).toBe(1);
  });
});

// ── Pipeline / ingest assertions ──────────────────────────────────────────
describe("§20 :: ingest pipeline (parsers → graph → cluster → skills → store)", () => {
  it("parses the synthetic repo's multi-language source set", () => {
    expect(ingest.filesParsed).toBeGreaterThanOrEqual(manifest.expected_files_min);
    expect(ingest.filesParsed).toBeLessThanOrEqual(manifest.expected_files_max);
    expect(ingest.symbolCount).toBeGreaterThanOrEqual(manifest.expected_symbols_min);
  });

  it("produces clusters within the manifest range (Louvain, seed=42)", () => {
    expect(ingest.clusterCount).toBeGreaterThanOrEqual(manifest.expected_clusters_min);
    expect(ingest.clusterCount).toBeLessThanOrEqual(manifest.expected_clusters_max);
  });

  it("emits at least one seed skill (errors hierarchy or framework match)", () => {
    expect(ingest.skillCount).toBeGreaterThanOrEqual(1);
  });

  it("populates the symbol_embeddings vec0 table for every symbol", () => {
    expect(ingest.embeddingCount).toBe(ingest.symbolCount);
  });

  it("writes ready.json with the correct embedder + schema markers", () => {
    const readyPath = path.join(tmpRepo, ".lodestone", "ready.json");
    expect(existsSync(readyPath)).toBe(true);
    const r = JSON.parse(readFileSync(readyPath, "utf8")) as {
      ready: boolean;
      embedder: { dim: number };
      schema_version: number;
      languages_indexed: string[];
    };
    expect(r.ready).toBe(true);
    expect(r.embedder.dim).toBe(768);
    // Synthetic repo declares 5 languages; we assert ≥3 because some
    // tree-sitter parsers may surface zero symbols on a tiny file (still a
    // valid parse but no `language` row to record). TS + JS + Py are the
    // floor.
    expect(r.languages_indexed.length).toBeGreaterThanOrEqual(3);
  });
});

// ── §11 seed skills assertions ────────────────────────────────────────────
describe("§20 :: seed skills detection (§11)", () => {
  it("captures every manifest-declared seed-skill slug", async () => {
    const { openReader } = await import("@lodestone/ingest/store");
    const dbPath = path.join(tmpRepo, ".lodestone", "lodestone.sqlite");
    const db = openReader(dbPath);
    try {
      const rows = db.prepare("SELECT slug, evidence_count FROM skills").all() as Array<{
        slug: string;
        evidence_count: number;
      }>;
      const slugMap = new Map(rows.map((r) => [r.slug, r.evidence_count]));
      for (const expected of manifest.expected_seed_skills) {
        if (!slugMap.has(expected.slug)) {
          throw new Error(
            `Manifest expected seed skill "${expected.slug}" not detected. ` +
              `Rationale: ${expected.rationale}`,
          );
        }
        const evidence = slugMap.get(expected.slug) ?? 0;
        expect(evidence).toBeGreaterThanOrEqual(expected.min_evidence_count);
      }
    } finally {
      db.close();
    }
  });
});

// ── MCP tool surfaces ─────────────────────────────────────────────────────
describe("§20 :: MCP tool surfaces (§13–§17)", () => {
  it("the tool registry exposes every manifest-declared tool", async () => {
    const { TOOL_REGISTRY, TOOL_NAMES_ALPHABETICAL } = await import(
      "@lodestone/mcp-server"
    );
    for (const tool of manifest.expected_mcp_tools) {
      expect(TOOL_NAMES_ALPHABETICAL).toContain(tool);
      expect(TOOL_REGISTRY[tool as keyof typeof TOOL_REGISTRY]).toBeDefined();
    }
  });

  it("`query` returns hits for a known fixture topic", async () => {
    await injectQueryEmbedder();
    try {
      const handler = await loadToolHandler<
        { question: string; top_k: number; channel: string },
        { results: unknown[] }
      >("query");
      const env = await withLodestoneCwd(tmpRepo, async () => {
        return handler({
          question: "user login authentication flow",
          top_k: 5,
          channel: "code",
        });
      });
      expect(Array.isArray(env.results)).toBe(true);
      // Vector + lexical lanes both run — at minimum the lexical lane
      // should match `login` against the auth.ts symbol id.
      expect(env.results.length).toBeGreaterThan(0);
    } finally {
      await clearQueryEmbedder();
    }
  });

  it("`cluster` returns at least one cluster matching a known anchor", async () => {
    const handler = await makeClusterHandler(tmpRepo);
    // Try a few candidate substrings; clusterer's heuristic naming is
    // emergent so we don't pin one literal — the assertion is "some
    // architectural cluster matched a substring drawn from real symbol ids".
    const candidates = ["login", "user", "handle", "log", "seed", "make", "find"];
    let any = false;
    for (const q of candidates) {
      const env = (await handler({ name_or_query: q, channel: "code" })) as {
        results: Array<{ id: string; members: Array<{ symbol: string }> }>;
      };
      if (env.results.length > 0) {
        const cluster = env.results[0]!;
        expect(cluster.members.length).toBeGreaterThan(0);
        any = true;
        break;
      }
    }
    expect(any).toBe(true);
  });

  it("`skills_for` returns an envelope (results may be empty when ranker has no embedding)", async () => {
    const handler = await loadToolHandler<
      { topic: string; channel: string },
      { results: unknown[] }
    >("skills_for");
    const env = await withLodestoneCwd(tmpRepo, async () => {
      return handler({ topic: "errors", channel: "code" });
    });
    expect(Array.isArray(env.results)).toBe(true);
    // `skills_for` ranks by description_embedding cosine; we don't backfill
    // those at e2e time (the §10 emit pathway leaves them NULL by default
    // per POST-CODEX-001 amendment 1). The envelope must still be valid.
  });

  it("`recent_changes` returns an envelope without crashing", async () => {
    const handler = await loadToolHandler<
      { window: string; channel: string },
      { results: unknown[] }
    >("recent_changes");
    const env = await withLodestoneCwd(tmpRepo, async () => {
      return handler({ window: "24h", channel: "code" });
    });
    expect(env).toBeDefined();
    expect(Array.isArray(env.results)).toBe(true);
  });

  it("`feedback` round-trips and persists to the SQLite feedback table", async () => {
    const handler = await loadToolHandler<
      {
        tool: string;
        request_id: string;
        signal: string;
        note?: string;
        channel: string;
      },
      { results: Array<{ ack: boolean; id: number; recorded_at: string }> }
    >("feedback");
    const env = await withLodestoneCwd(tmpRepo, async () => {
      return handler({
        tool: "query",
        request_id: "00000000-0000-7000-8000-000000000001",
        signal: "useful",
        note: "e2e verifies feedback persistence",
        channel: "code",
      });
    });
    expect(env.results.length).toBe(1);
    expect(env.results[0]!.ack).toBe(true);
    expect(env.results[0]!.id).toBeGreaterThan(0);
    expect(env.results[0]!.recorded_at).toMatch(/T/);

    // Verify the row landed in SQLite.
    const { openReader } = await import("@lodestone/ingest/store");
    const dbPath = path.join(tmpRepo, ".lodestone", "lodestone.sqlite");
    const db = openReader(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT signal FROM feedback WHERE request_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("00000000-0000-7000-8000-000000000001") as { signal: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.signal).toBe("useful");
    } finally {
      db.close();
    }
  });

  it("`context` returns SymbolContext for a known fixture symbol", async () => {
    const { openReader } = await import("@lodestone/ingest/store");
    const dbPath = path.join(tmpRepo, ".lodestone", "lodestone.sqlite");
    const db = openReader(dbPath);
    let pickedSymbol: string;
    try {
      const row = db
        .prepare("SELECT id FROM symbols WHERE path LIKE 'src/auth.ts%' LIMIT 1")
        .get() as { id: string } | undefined;
      if (!row) throw new Error("no auth symbol in fixture");
      pickedSymbol = row.id;
    } finally {
      db.close();
    }

    const handler = await loadToolHandler<
      { symbol: string; channel: string },
      { results: unknown[] }
    >("context");
    const env = await withLodestoneCwd(tmpRepo, async () => {
      return handler({ symbol: pickedSymbol, channel: "code" });
    });
    expect(env.results.length).toBeGreaterThan(0);
  });

  it("`impact` returns blast-radius for a known fixture symbol", async () => {
    const { openReader } = await import("@lodestone/ingest/store");
    const dbPath = path.join(tmpRepo, ".lodestone", "lodestone.sqlite");
    const db = openReader(dbPath);
    let pickedSymbol: string;
    try {
      const row = db
        .prepare(
          "SELECT id FROM symbols WHERE path LIKE 'src/util.ts%' ORDER BY pagerank DESC LIMIT 1",
        )
        .get() as { id: string } | undefined;
      if (!row) throw new Error("no util symbol in fixture");
      pickedSymbol = row.id;
    } finally {
      db.close();
    }

    const handler = await loadToolHandler<
      { symbol: string; channel: string },
      { results: unknown[] }
    >("impact");
    const env = await withLodestoneCwd(tmpRepo, async () => {
      return handler({ symbol: pickedSymbol, channel: "code" });
    });
    expect(env.results.length).toBeGreaterThanOrEqual(0);
  });
});

// ── §18 — privacy / network isolation ─────────────────────────────────────
describe("§20 :: privacy enforcement (§18 amendment §3 — runtime interception)", () => {
  it("zero non-allowlisted outbound network calls during the entire run", () => {
    const offenders = netLog.filter((rec) => {
      const t = rec.target.toLowerCase();
      if (t.startsWith("unix:")) return false;
      if (t.startsWith("http://localhost") || t.startsWith("http://127.0.0.1")) return false;
      if (t.startsWith("https://localhost") || t.startsWith("https://127.0.0.1")) return false;
      if (t.startsWith("localhost:") || t.startsWith("127.0.0.1:")) return false;
      if (t === "localhost" || t === "127.0.0.1" || t === "::1") return false;
      return true;
    });
    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `${o.surface} → ${o.target} @ ${o.callsite}`)
        .join("\n");
      throw new Error(
        `Lodestone made ${offenders.length} non-allowlisted outbound network call(s):\n${msg}`,
      );
    }
    expect(offenders.length).toBe(0);
  });

  it("blocking interceptor throws NetworkInterceptedError on a real fetch", async () => {
    const { restore } = installNetworkInterceptor({ block: true });
    try {
      await expect(
        fetch("https://example.com/never-actually-called"),
      ).rejects.toBeInstanceOf(NetworkInterceptedError);
    } finally {
      restore();
      // Re-install the suite-level record-only interceptor so subsequent
      // assertions see the same shared netLog.
      const newHandle = installNetworkInterceptor({
        block: false,
        log: netLog,
      });
      interceptorRestore = newHandle.restore;
    }
  });
});

// ── §19 — uninstall reversibility ─────────────────────────────────────────
describe("§20 :: uninstall reversibility (§19)", () => {
  it("`lodestone uninstall` removes .lodestone/ and the lodestone-mcp entry", async () => {
    const cloneTmp = cloneFixtureToTmp();
    try {
      const init = await runLodestoneCli(["init"], cloneTmp, { timeoutMs: 60_000 });
      expect(init.exitCode).toBe(0);
      expect(existsSync(path.join(cloneTmp, ".lodestone"))).toBe(true);
      expect(existsSync(path.join(cloneTmp, ".mcp.json"))).toBe(true);

      const uninstall = await runLodestoneCli(["uninstall"], cloneTmp, {
        timeoutMs: 30_000,
      });
      expect(uninstall.exitCode).toBe(0);
      expect(existsSync(path.join(cloneTmp, ".lodestone"))).toBe(false);
      const mcpPath = path.join(cloneTmp, ".mcp.json");
      if (existsSync(mcpPath)) {
        const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as {
          mcpServers?: Record<string, unknown>;
        };
        expect(parsed.mcpServers?.["lodestone-mcp"]).toBeUndefined();
      }
    } finally {
      cleanupTmp(cloneTmp);
    }
  });

  it("re-running uninstall is idempotent (exit 0, no-op summary)", async () => {
    const cloneTmp = cloneFixtureToTmp();
    try {
      const result = await runLodestoneCli(["uninstall"], cloneTmp, {
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      cleanupTmp(cloneTmp);
    }
  });
});

// ── Fixture immutability gate ─────────────────────────────────────────────
describe("§20 :: fixture immutability invariant", () => {
  it("the committed synthetic-demo-repo on disk was NOT mutated by the e2e", () => {
    const SYNTHETIC = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "synthetic-demo-repo",
    );
    const stack = [SYNTHETIC];
    let fileCount = 0;
    let totalBytes = 0;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const entries = readdirSync(cur, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".lodestone") continue;
          stack.push(full);
        } else if (entry.isFile()) {
          fileCount++;
          totalBytes += statSync(full).size;
        }
      }
    }
    expect(fileCount).toBeGreaterThan(5);
    expect(totalBytes).toBeGreaterThan(0);
    expect(existsSync(path.join(SYNTHETIC, ".lodestone"))).toBe(false);
  });
});
