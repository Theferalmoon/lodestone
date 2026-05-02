// SPDX-License-Identifier: Apache-2.0
// Lodestone — persistence/ORM-convention seed-skill scanner.
//
// POST-CODEX-001 §1 amendment to spec §11: added detectPersistencePatterns.
// Identifies the dominant repository / transaction wrapper imported across
// the codebase: ORMs (Prisma, Drizzle, TypeORM, SQLAlchemy, gorm, Diesel,
// Hibernate-via-Quarkus etc.), and lower-level drivers (better-sqlite3,
// pg, mysql2, sqlx) that the codebase wraps directly. Conservative ≥2
// importers per the rest of §11.

import { createHash } from "node:crypto";

import type { ParseResult } from "../parsers/base.js";

import type { SeedSkillInput, SeedSkillRecord } from "./types.js";

interface PersistenceSig {
  display: string;
  needles: readonly string[];
  language?: string;
  /** Short summary of the canonical transaction / session pattern. */
  txHint?: string;
}

const PERSISTENCE_LIBS: ReadonlyArray<PersistenceSig> = [
  // TS/JS — high-level ORMs first.
  {
    display: "Prisma",
    needles: ["@prisma/client", "prisma"],
    language: "TypeScript/JavaScript",
    txHint: "Use prisma.$transaction([...]) for multi-statement work; prisma is a singleton.",
  },
  {
    display: "Drizzle",
    needles: ["drizzle-orm"],
    language: "TypeScript/JavaScript",
    txHint: "Use db.transaction(async (tx) => { ... }) and pass `tx` to query builders.",
  },
  {
    display: "TypeORM",
    needles: ["typeorm"],
    language: "TypeScript/JavaScript",
    txHint: "Use dataSource.transaction(async (em) => { ... }) and pass `em` (EntityManager).",
  },
  {
    display: "Sequelize",
    needles: ["sequelize"],
    language: "TypeScript/JavaScript",
    txHint: "Use sequelize.transaction(async (t) => { ... }).",
  },
  {
    display: "Mongoose",
    needles: ["mongoose"],
    language: "TypeScript/JavaScript",
  },
  {
    display: "Kysely",
    needles: ["kysely"],
    language: "TypeScript/JavaScript",
    txHint: "Use db.transaction().execute(async (trx) => { ... }).",
  },
  // TS/JS — drivers (used when no ORM is detected).
  {
    display: "better-sqlite3",
    needles: ["better-sqlite3"],
    language: "TypeScript/JavaScript",
    txHint: "Use db.transaction(() => { ... })() — synchronous, returns a callable.",
  },
  { display: "node-postgres (pg)", needles: ["pg"], language: "TypeScript/JavaScript" },
  { display: "mysql2", needles: ["mysql2", "mysql2/promise"], language: "TypeScript/JavaScript" },
  // Python
  {
    display: "SQLAlchemy",
    needles: ["sqlalchemy"],
    language: "Python",
    txHint: "Use a session = Session(engine); call session.commit() / session.rollback() explicitly.",
  },
  { display: "Django ORM", needles: ["django.db"], language: "Python" },
  { display: "Tortoise ORM", needles: ["tortoise"], language: "Python" },
  // Go
  {
    display: "gorm",
    needles: ["gorm.io/gorm"],
    language: "Go",
    txHint: "Use db.Transaction(func(tx *gorm.DB) error { ... }).",
  },
  { display: "sqlx (Go)", needles: ["github.com/jmoiron/sqlx"], language: "Go" },
  { display: "ent", needles: ["entgo.io/ent"], language: "Go" },
  // Rust
  {
    display: "sqlx",
    needles: ["sqlx"],
    language: "Rust",
    txHint: "Use let mut tx = pool.begin().await?; tx.commit().await?; pattern.",
  },
  { display: "Diesel", needles: ["diesel"], language: "Rust" },
  { display: "SeaORM", needles: ["sea_orm", "sea-orm"], language: "Rust" },
];

export function detectPersistencePatterns(
  input: SeedSkillInput,
): SeedSkillRecord | null {
  const importEdges = collectImportEdges(input.parseResults);
  if (importEdges.length === 0) return null;

  const scores = new Map<number, Set<string>>();
  for (let i = 0; i < PERSISTENCE_LIBS.length; i++) scores.set(i, new Set());

  for (const e of importEdges) {
    for (let i = 0; i < PERSISTENCE_LIBS.length; i++) {
      if (matchesNeedle(e.module, PERSISTENCE_LIBS[i]!.needles)) {
        scores.get(i)!.add(e.from);
        break;
      }
    }
  }

  let bestIdx = -1;
  let bestCount = 0;
  for (const [idx, importers] of scores) {
    if (importers.size > bestCount) {
      bestCount = importers.size;
      bestIdx = idx;
    }
  }
  if (bestIdx < 0 || bestCount < 2) return null;

  const sig = PERSISTENCE_LIBS[bestIdx]!;
  const importers = scores.get(bestIdx)!;
  const sortedImporters = Array.from(importers).sort();
  const samplePaths = sortedImporters.slice(0, 5);

  const id = stableId(`seed:persistence:${sig.display}:${sortedImporters.join("|")}`);
  const description = `Codebase persists state via \`${sig.display}\` across ${importers.size} file(s).`;
  const body = renderBody({
    sig,
    importerCount: importers.size,
    samplePaths,
  });

  return {
    id,
    slug: "persistence",
    name: "Persistence / transaction convention",
    description,
    body,
    evidence_count: importers.size,
    sample_paths: samplePaths,
  };
}

interface ImportSite {
  from: string;
  module: string;
}

function collectImportEdges(parseResults: readonly ParseResult[]): ImportSite[] {
  const out: ImportSite[] = [];
  for (const pr of parseResults) {
    for (const e of pr.edges) {
      if (e.kind !== "imports") continue;
      const m = (e.to_path ?? e.to_name ?? "").trim();
      if (m.length === 0) continue;
      out.push({ from: e.from, module: stripQuotes(m) });
    }
  }
  return out;
}

function matchesNeedle(module: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (module === n) return true;
    if (module.startsWith(`${n}/`)) return true;
    if (module.startsWith(`${n}.`)) return true;
  }
  return false;
}

interface BodyCtx {
  sig: PersistenceSig;
  importerCount: number;
  samplePaths: readonly string[];
}

function renderBody(ctx: BodyCtx): string {
  const lines: string[] = [];
  lines.push("# Persistence / transaction convention", "");

  lines.push("## What", "");
  const langSuffix = ctx.sig.language ? ` (${ctx.sig.language})` : "";
  lines.push(
    `This codebase persists state via \`${ctx.sig.display}\`${langSuffix} across ${ctx.importerCount} file(s). New repository / data-access code should reuse this layer; do NOT introduce a parallel ORM or driver alongside it.`,
    "",
  );

  lines.push("## Where", "");
  for (const p of ctx.samplePaths) lines.push(`- \`${p}\``);
  lines.push("");

  if (ctx.sig.txHint) {
    lines.push("## Transactions", "");
    lines.push(ctx.sig.txHint, "");
  }

  lines.push("## How to follow it", "");
  lines.push(
    `When adding a new repository function, import \`${ctx.sig.display}\` from the same entry point the existing files use, and respect the project's transaction boundary helper. Multi-statement writes that need atomicity must use the project's transaction wrapper, not raw client calls.`,
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
