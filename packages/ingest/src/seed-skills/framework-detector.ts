// SPDX-License-Identifier: Apache-2.0
// Lodestone — framework-detector seed-skill scanner.
//
// Detects which web/server framework(s) the codebase imports and emits one
// seed Skill per detected framework. Reads §06 ParseResult.edges (filtered
// to `kind: "imports"`) and matches against a curated list of well-known
// framework module specifiers.
//
// Per §11 spec: scanners stay conservative. We require ≥2 distinct importing
// files for a framework to qualify ("one import is not a convention").

import { createHash } from "node:crypto";

import type { ParserEdge } from "../parsers/base.js";

import type { SeedSkillInput, SeedSkillRecord } from "./types.js";

/**
 * Curated framework signatures. `match` is the set of import-source needles
 * (literal substring after stripping `import "…"` quoting via the parser).
 *
 * `slug` and `name` drive the rendered card; `handlerHint` is a short,
 * canonical handler-signature description rendered into the body so agents
 * have a starting point when adding new routes.
 */
interface FrameworkSignature {
  slug: string;
  name: string;
  /** Display label inside the card body (preserves casing/punctuation). */
  display: string;
  /** Module specifiers (or substrings) that indicate this framework is in use. */
  imports: readonly string[];
  /** Short summary of the canonical handler signature. */
  handlerHint: string;
  /** Optional: language(s) the framework belongs to (informational). */
  languages: readonly string[];
}

const FRAMEWORK_SIGNATURES: readonly FrameworkSignature[] = [
  {
    slug: "framework-express",
    name: "Express HTTP handler convention",
    display: "Express",
    imports: ["express"],
    handlerHint: "(req, res, next) => { ... }  /  (req, res) => { ... }",
    languages: ["typescript", "javascript"],
  },
  {
    slug: "framework-fastify",
    name: "Fastify HTTP handler convention",
    display: "Fastify",
    imports: ["fastify"],
    handlerHint: "async (request, reply) => { ... }",
    languages: ["typescript", "javascript"],
  },
  {
    slug: "framework-koa",
    name: "Koa HTTP handler convention",
    display: "Koa",
    imports: ["koa"],
    handlerHint: "async (ctx, next) => { ... }",
    languages: ["typescript", "javascript"],
  },
  {
    slug: "framework-hono",
    name: "Hono HTTP handler convention",
    display: "Hono",
    imports: ["hono"],
    handlerHint: "(c) => c.json({ ... })",
    languages: ["typescript", "javascript"],
  },
  {
    slug: "framework-fastapi",
    name: "FastAPI route convention",
    display: "FastAPI",
    imports: ["fastapi"],
    handlerHint: "async def handler(request: Request) -> Response",
    languages: ["python"],
  },
  {
    slug: "framework-flask",
    name: "Flask route convention",
    display: "Flask",
    imports: ["flask"],
    handlerHint: "@app.route('/path')\\ndef handler(): ...",
    languages: ["python"],
  },
  {
    slug: "framework-django",
    name: "Django URL/view convention",
    display: "Django",
    imports: ["django.urls", "django"],
    handlerHint: "def view(request: HttpRequest) -> HttpResponse",
    languages: ["python"],
  },
  {
    slug: "framework-gin",
    name: "Gin HTTP handler convention",
    display: "Gin",
    imports: ["github.com/gin-gonic/gin"],
    handlerHint: "func(c *gin.Context) { ... }",
    languages: ["go"],
  },
  {
    slug: "framework-chi",
    name: "Chi HTTP handler convention",
    display: "Chi",
    imports: ["github.com/go-chi/chi"],
    handlerHint: "func(w http.ResponseWriter, r *http.Request) { ... }",
    languages: ["go"],
  },
  {
    slug: "framework-axum",
    name: "Axum HTTP handler convention",
    display: "Axum",
    imports: ["axum"],
    handlerHint: "async fn handler(...) -> impl IntoResponse",
    languages: ["rust"],
  },
  {
    slug: "framework-actix",
    name: "Actix Web HTTP handler convention",
    display: "Actix Web",
    imports: ["actix_web", "actix-web"],
    handlerHint: "async fn handler(...) -> impl Responder",
    languages: ["rust"],
  },
];

/**
 * Detect every framework with ≥2 distinct importing files. Returns one
 * SeedSkillRecord per framework, ordered by descending evidence_count
 * (so the dominant framework slot-0 in the result list).
 */
export function detectFrameworks(input: SeedSkillInput): SeedSkillRecord[] {
  const importEdges = collectImportEdges(input.parseResults);
  if (importEdges.length === 0) return [];

  const out: SeedSkillRecord[] = [];

  for (const sig of FRAMEWORK_SIGNATURES) {
    const importers = matchImporters(importEdges, sig.imports);
    if (importers.size < 2) continue;
    out.push(buildFrameworkSkill(sig, importers));
  }

  // Stable order: highest evidence first; tiebreak by slug for determinism.
  out.sort((a, b) => {
    if (b.evidence_count !== a.evidence_count) {
      return b.evidence_count - a.evidence_count;
    }
    return a.slug.localeCompare(b.slug);
  });

  return out;
}

interface ImportSite {
  /** The importing file path (= the parser's `from` for an `imports` edge). */
  importer_path: string;
  /** Resolved module source — may be the literal `to_path` or `to_name`. */
  module: string;
}

function collectImportEdges(
  parseResults: readonly { edges: readonly ParserEdge[] }[],
): ImportSite[] {
  const out: ImportSite[] = [];
  for (const result of parseResults) {
    for (const edge of result.edges) {
      if (edge.kind !== "imports") continue;
      // For `imports` edges, parsers set `from` to the file path itself.
      const moduleSource = (edge.to_path ?? edge.to_name ?? "").trim();
      if (moduleSource.length === 0) continue;
      out.push({
        importer_path: edge.from,
        module: stripQuotes(moduleSource),
      });
    }
  }
  return out;
}

function matchImporters(
  edges: readonly ImportSite[],
  needles: readonly string[],
): Map<string, string[]> {
  const importerToModules = new Map<string, string[]>();
  for (const e of edges) {
    if (!matchesNeedle(e.module, needles)) continue;
    const list = importerToModules.get(e.importer_path) ?? [];
    list.push(e.module);
    importerToModules.set(e.importer_path, list);
  }
  return importerToModules;
}

function matchesNeedle(module: string, needles: readonly string[]): boolean {
  // Use exact-match against the module specifier, plus a prefix-with-dot/slash
  // form so `fastapi.responses` matches the `fastapi` needle, and so
  // `github.com/gin-gonic/gin/binding` matches `github.com/gin-gonic/gin`.
  for (const needle of needles) {
    if (module === needle) return true;
    if (module.startsWith(`${needle}/`)) return true;
    if (module.startsWith(`${needle}.`)) return true;
  }
  return false;
}

function buildFrameworkSkill(
  sig: FrameworkSignature,
  importers: Map<string, string[]>,
): SeedSkillRecord {
  const importerPaths = Array.from(importers.keys()).sort();
  const samplePaths = importerPaths.slice(0, 5);

  const idSource = `seed:framework:${sig.slug}:${importerPaths.join("|")}`;
  const id = stableId(idSource);

  const description = `Codebase uses ${sig.display} for HTTP routing across ${importerPaths.length} file(s).`;

  const body = renderFrameworkBody({
    sig,
    importerCount: importerPaths.length,
    samplePaths,
  });

  return {
    id,
    slug: sig.slug,
    name: sig.name,
    description,
    body,
    evidence_count: importerPaths.length,
    sample_paths: samplePaths,
  };
}

interface FrameworkBodyContext {
  sig: FrameworkSignature;
  importerCount: number;
  samplePaths: string[];
}

function renderFrameworkBody(ctx: FrameworkBodyContext): string {
  const lines: string[] = [];
  lines.push(`# ${ctx.sig.name}`, "");

  lines.push("## What", "");
  lines.push(
    `This codebase imports \`${ctx.sig.display}\` from ${ctx.importerCount} file(s). New HTTP routes / handlers should follow the same framework — do not introduce a second router framework alongside it without an explicit team decision.`,
    "",
  );

  lines.push("## Where", "");
  for (const p of ctx.samplePaths) lines.push(`- \`${p}\``);
  lines.push("");

  lines.push("## Canonical handler signature", "");
  lines.push("```", ctx.sig.handlerHint, "```", "");

  lines.push("## How to follow it", "");
  lines.push(
    `When adding a new endpoint, register it on the existing ${ctx.sig.display} router/app instance and use the canonical handler signature above. Pull request reviewers should reject net-new routes that bypass the framework.`,
    "",
  );

  return lines.join("\n");
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function stableId(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}
