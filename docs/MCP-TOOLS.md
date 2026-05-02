<!-- SPDX-License-Identifier: Apache-2.0 -->

# MCP tool reference

Lodestone exposes eight tools over the Model Context Protocol. Your editor's coding agent (Claude Code, Cursor, Cline, etc.) discovers them through the `.mcp.json` snippet that `lodestone init` writes. This document covers the universal response envelope, then each tool one by one.

## The universal envelope

Every Lodestone tool returns the same outer shape:

```typescript
interface LodestoneToolResponse<T> {
  request_id: string;       // UUID v7, server-generated. Used by feedback() to reference this call.
  results: T[];             // Per-tool payload. Always an array, even for "context" (one symbol).
  provenance: Provenance;   // Git + index state at the moment the tool ran. Lets the agent reason about staleness.
  diagnostics: Diagnostics; // Coverage, warnings, truncation/clamp flags.
}
```

`Provenance` carries the head commit, the indexed commit, dirty-tree flags, upstream-branch state, the staleness in seconds, and a `source` field set to `"live"`, `"stale"`, or `"not_ready"`. When `source === "not_ready"` the index has not finished its first ingest pass — the agent should treat the response as preliminary. The full schema (with sentinel values for never-indexed and non-git directories) is in `packages/shared/src/types/envelope.ts`.

`Diagnostics` carries `coverage` (0..1, files-indexed-vs-non-ignored), an optional `warnings` array, an optional `truncated` flag (set when the response was clipped to fit `[mcp].max_response_kb`), and an optional `clamped` flag (set when an input parameter like `top_k` was silently capped).

The agent should learn the envelope once. Per-tool sections below describe only the `T` payload.

## Tools by purpose

| Group | Tools |
|---|---|
| Search | `query`, `recent_changes` |
| Graph | `context`, `impact`, `sql` |
| Moat | `cluster`, `skills_for` |
| Write | `feedback` |

## `query`

Hybrid semantic + keyword + graph search over the project's symbols. Returns the top-K most relevant functions, methods, classes, interfaces, types, modules, or constants for a natural-language question. Combines vector similarity (sqlite-vec), BM25 keyword match, and PageRank-weighted graph proximity. Use this as the default discovery tool when the agent needs to find code by intent rather than by exact name.

**Input:**

```typescript
{
  question: string;             // required, non-empty
  top_k?: number;               // 1..50, default 10. Over-cap is silently clamped (diagnostics.clamped=true).
  filters?: {
    paths?: string[];           // glob patterns, e.g. ["src/auth/**"]
    languages?: string[];       // e.g. ["typescript", "python"]
    since?: string;             // ISO-8601, only symbols touched since this date
  };
}
```

**Example request / response:**

```json
{
  "question": "where is the rate limiter?",
  "top_k": 3
}
```

```json
{
  "request_id": "01939c6a-1234-7abc-9def-0123456789ab",
  "results": [
    { "id": "ts:src/middleware/rate-limit.ts:RateLimiter", "name": "RateLimiter", "kind": "class", "path": "src/middleware/rate-limit.ts", "score": 0.91 },
    { "id": "ts:src/middleware/rate-limit.ts:checkBucket", "name": "checkBucket", "kind": "function", "path": "src/middleware/rate-limit.ts", "score": 0.78 }
  ],
  "provenance": { "is_git_repo": true, "head_commit": "abc1234", "indexed_commit": "abc1234", "dirty_at_index": false, "dirty_now": false, "commits_since_index": 0, "has_upstream": true, "upstream_branch": "origin/main", "commits_behind_upstream": 0, "indexed_at": "2026-05-01T14:00:00Z", "staleness_seconds": 12, "index_epoch": 47, "source": "live" },
  "diagnostics": { "coverage": 0.98, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

**When NOT to use:** if the agent already has a fully-qualified symbol (`pkg::Type::method`), call `context` directly — `query` will work but `context` is faster and returns richer per-symbol detail.

## `recent_changes`

List symbols (functions, methods, classes) most recently touched by git commits in the project. Optional ISO-8601 `since` filter narrows to a time window; default `top_k=20` returns the freshest changes. Useful when the agent needs to orient on what just changed before answering a question, debugging a regression, or summarizing the day's work. Reads from the SQLite `symbols.updated_at_commit` index — no shell-out to git on the request path.

**Input:**

```typescript
{
  since?: string;   // ISO-8601, e.g. "2026-04-30T00:00:00Z"
  top_k?: number;   // 1..50, default 20
}
```

**Example request / response:**

```json
{ "since": "2026-04-29T00:00:00Z", "top_k": 5 }
```

```json
{
  "request_id": "01939c6a-2222-7abc-9def-0123456789ab",
  "results": [
    { "id": "ts:src/auth/session.ts:rotateToken", "name": "rotateToken", "path": "src/auth/session.ts", "last_commit": "def5678", "last_commit_at": "2026-04-30T11:23:00Z" }
  ],
  "provenance": { "is_git_repo": true, "head_commit": "def5678", "indexed_commit": "def5678", "dirty_at_index": false, "dirty_now": false, "commits_since_index": 0, "has_upstream": true, "upstream_branch": "origin/main", "commits_behind_upstream": 0, "indexed_at": "2026-04-30T11:24:00Z", "staleness_seconds": 5, "index_epoch": 51, "source": "live" },
  "diagnostics": { "coverage": 1.0, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

**When NOT to use:** for "what was changed in commit X" use git directly; this tool is symbol-keyed, not commit-keyed.

## `context`

Return the architectural context surrounding a specific symbol: its callers, callees, the cluster it belongs to, the cluster's purpose, sibling symbols inside the same cluster, and any skill cards that mention it. Use this when the agent has a candidate symbol (from `query` or from a stack trace) and needs to understand how it fits into the codebase before editing. Pulls from SQLite edges, clusters, and skills tables in a single bounded read pass.

**Input:**

```typescript
{
  symbol: string;   // required. Three resolution paths:
                    //   - contains "::"    → fully-qualified, single-symbol lookup
                    //   - contains "/" or .ext → file-path, file-level summary
                    //   - otherwise        → bare-name; returns SymbolMatches with hint
}
```

**Example request / response:**

```json
{ "symbol": "src/auth/session.ts::rotateToken" }
```

```json
{
  "request_id": "01939c6a-3333-7abc-9def-0123456789ab",
  "results": [{
    "symbol": { "id": "ts:src/auth/session.ts:rotateToken", "name": "rotateToken", "kind": "function", "path": "src/auth/session.ts", "range": { "start_line": 42, "end_line": 71 } },
    "callers": [ { "id": "ts:src/api/login.ts:handleLogin", "pagerank": 0.012 } ],
    "callees": [ { "id": "ts:src/auth/jwt.ts:sign", "pagerank": 0.008 } ],
    "cluster": { "id": 7, "name": "Auth & Sessions", "name_status": "heuristic" }
  }],
  "provenance": { "...": "..." },
  "diagnostics": { "coverage": 1.0, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

Caller/callee lists are capped at 50 each.

**When NOT to use:** for blast-radius analysis ("what would break if I change this?") use `impact`. `context` is one hop deep; `impact` is recursive.

## `impact`

Return the reverse-reachability set for a file or symbol: all callers, all transitive importers, the clusters they live in, and a rough blast-radius score. Use this BEFORE editing a function to understand what might break, or AFTER seeing a test fail to find related call sites. Backed by a recursive CTE over the SQLite `edges` table, bounded by depth (5) and result count (100) to keep response size sane.

**Input:**

```typescript
{
  file_or_symbol: string;   // required. File path or fully-qualified symbol id.
}
```

**Example request / response:**

```json
{ "file_or_symbol": "src/auth/session.ts::rotateToken" }
```

```json
{
  "request_id": "01939c6a-4444-7abc-9def-0123456789ab",
  "results": [
    { "id": "ts:src/api/login.ts:handleLogin", "depth": 1, "pagerank": 0.012, "cluster": { "id": 4, "name": "API handlers" } },
    { "id": "ts:src/middleware/auth-required.ts:guard", "depth": 2, "pagerank": 0.009, "cluster": { "id": 4, "name": "API handlers" } }
  ],
  "provenance": { "...": "..." },
  "diagnostics": { "coverage": 1.0, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

**When NOT to use:** for forward dependencies of a symbol (what does it call?) use `context` and read its `callees` field.

## `cluster` (moat)

Return the architectural cluster (community) matching a name or natural-language query. Each cluster is a Louvain-detected group of symbols representing an emergent module — auth, payments, ingest, etc. The response carries the cluster's heuristic name, its `name_status` (heuristic vs human-confirmed), an `agent_instruction` string telling the calling agent how to interact with the cluster, `naming_evidence` (anchor symbol, members sampled), and the member symbol IDs. Granularity selects between Louvain resolution levels (fine | medium | coarse). This is the core moat surface for code-aware agents.

**Input:**

```typescript
{
  name_or_query: string;                            // required, non-empty
  granularity?: "fine" | "medium" | "coarse";      // default "medium"
}
```

**Example request / response:**

```json
{ "name_or_query": "auth", "granularity": "medium" }
```

```json
{
  "request_id": "01939c6a-5555-7abc-9def-0123456789ab",
  "results": [{
    "id": 7,
    "name": "Auth & Sessions",
    "name_status": "heuristic",
    "agent_instruction": "synthesize_name_from_members",
    "naming_evidence": { "anchor_symbol": "ts:src/auth/session.ts:rotateToken", "members_sampled": 23 },
    "members": ["ts:src/auth/session.ts:rotateToken", "ts:src/auth/jwt.ts:sign", "ts:src/auth/jwt.ts:verify"]
  }],
  "provenance": { "...": "..." },
  "diagnostics": { "coverage": 1.0, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

The `agent_instruction` field is load-bearing: when `name_status === "heuristic"` it says `"synthesize_name_from_members"`, telling the agent to treat the cluster name as a starting hint and re-derive its own label from the member list. When a human has confirmed the name (via the `feedback` tool), `name_status === "human"` and `agent_instruction === "use_as_is"`.

**When NOT to use:** if the agent wants per-symbol detail rather than a group view, use `query` or `context`.

## `skills_for` (moat)

Return the most relevant skill cards for a coding task. Skill cards are codebase-specific patterns Lodestone learned from the project — error-handling conventions, dependency-injection style, testing idioms, naming conventions, lint-preferred imports — surfaced as concise, actionable summaries with example symbol references and a maturity tag (`seed | emerging | mature`). The agent should consult these BEFORE writing code so its output matches the project's house style. `top_k` defaults to 5; semantic match against a task description.

**Input:**

```typescript
{
  task_description: string;   // required, non-empty
  top_k?: number;             // ≥1, default 5. Over-cap is silently clamped.
}
```

**Example request / response:**

```json
{ "task_description": "add a new API handler for user profile updates", "top_k": 3 }
```

```json
{
  "request_id": "01939c6a-6666-7abc-9def-0123456789ab",
  "results": [
    { "title": "API handlers follow router-handler-service-repo", "maturity": "emerging", "confidence": 0.74, "anchor_symbols": ["ts:src/api/login.ts:handleLogin", "ts:src/api/users.ts:handleGetUser"], "body_excerpt": "Handlers parse the request, delegate to a service, and never touch the repo layer directly..." },
    { "title": "Errors use AppError subclass family", "maturity": "mature", "confidence": 0.91, "anchor_symbols": ["ts:src/errors/app-error.ts:AppError", "ts:src/errors/auth-error.ts:AuthError"], "body_excerpt": "Throw a typed AppError subclass; the global handler maps to HTTP status..." }
  ],
  "provenance": { "...": "..." },
  "diagnostics": { "coverage": 1.0, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

**Honest framing:** `skills_for` is the emerging moat. Best results come after the index has watched the codebase for ≥7 days — the skill emitter requires `min_age_days` of cluster stability before promoting a card. Fresh installs return seed skills (deterministic patterns extracted at init time: error hierarchies, framework signatures). They are useful but less rich than emitted cards. As the index lives with the project longer, cards mature from `seed` → `emerging` → `mature` based on confirmation signals.

**When NOT to use:** for "find me a function that does X" use `query`. `skills_for` is for project conventions, not for symbol discovery.

## `feedback` (write tool)

Record agent feedback on a prior Lodestone tool call. Required fields: the tool name (`query`, `cluster`, `context`, etc.), the prior call's `request_id` (UUID v7 from the prior envelope), and a `signal` literal (`useful` | `not_useful` | `wrong` | `stale`). Optional `note` (≤2 KB) explains why. Feedback is the training signal Lodestone uses to improve cluster names, skill cards, and ranking — call this whenever a prior tool call was meaningfully helpful or unhelpful.

**Input:**

```typescript
{
  tool: string;                                          // required, e.g. "cluster"
  request_id: string;                                    // required, UUID from the prior envelope
  signal: "useful" | "not_useful" | "wrong" | "stale";   // required
  note?: string;                                         // optional, truncated to 2 KB
}
```

**Example request / response:**

```json
{
  "tool": "cluster",
  "request_id": "01939c6a-5555-7abc-9def-0123456789ab",
  "signal": "useful",
  "note": "Cluster name 'Auth & Sessions' matched the team's mental model exactly."
}
```

```json
{
  "request_id": "01939c6a-7777-7abc-9def-0123456789ab",
  "results": [{ "recorded_at": "2026-05-01T14:01:33Z" }],
  "provenance": { "...": "..." },
  "diagnostics": { "coverage": 1.0, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

This is the only Lodestone tool that writes. Feedback events live in the SQLite `feedback` table and feed downstream re-ranking + the cluster-name-promotion pipeline. There is no PII sent anywhere; the event stays on disk in `.lodestone/`.

**When NOT to use:** never call `feedback` without a `request_id` from a prior call — the tool will reject the request. The `request_id` is how Lodestone correlates the signal to the call it should learn from.

## `sql` (gated)

Execute an arbitrary SQL query against the project's read-only Lodestone SQLite index. Returns rows as JSON. **DANGEROUS:** only registered when `[mcp].dangerous_tools_enabled = true` AND `"sql"` is in `[mcp].expose`. The connection is opened readonly at the driver level so write attempts (INSERT, UPDATE, DELETE, DROP) throw — but the operator should still treat exposing this tool as a power-user feature, not a default. Use for ad-hoc graph traversals beyond the canned `query` / `context` / `impact` / `cluster` tools, or for debugging the index itself.

**Input:**

```typescript
{
  query: string;   // required, non-empty SQL
}
```

**Example request / response:**

```json
{ "query": "SELECT name, kind, path FROM symbols WHERE kind = 'class' ORDER BY pagerank DESC LIMIT 5" }
```

```json
{
  "request_id": "01939c6a-8888-7abc-9def-0123456789ab",
  "results": [
    { "name": "RateLimiter", "kind": "class", "path": "src/middleware/rate-limit.ts" },
    { "name": "AuthError",   "kind": "class", "path": "src/errors/auth-error.ts" }
  ],
  "provenance": { "...": "..." },
  "diagnostics": { "coverage": 1.0, "coverage_basis": "files-indexed-vs-non-ignored" }
}
```

The schema is in `packages/shared/src/schema/`. Useful tables: `symbols`, `edges`, `clusters`, `cluster_members`, `class_inheritance`, `skills`, `feedback`, `symbol_embeddings` (sqlite-vec virtual table).

> Historical note: this tool was originally specced as `cypher` against a KuzuDB graph engine. The §08 implementation collapsed to SQLite; the tool was renamed `sql` in the POST-CODEX-001 amendment block. The schema rejects `cypher` outright — use `sql`.

**When NOT to use:** if the canned tools cover your case, prefer them. They have caps, response truncation, and rank ordering that `sql` does not.
