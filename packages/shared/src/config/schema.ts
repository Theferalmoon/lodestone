// SPDX-License-Identifier: Apache-2.0
// zod schema + parser for `.lodestone/lodestone.toml`. Mirrors claude-plan.md §5.
//
// This module does NOT parse TOML text. It accepts the JS object that the CLI's
// TOML reader produces. Keeping TOML parsing out of @lodestone/shared avoids
// forcing an unwanted dep on every consumer.
import { z } from "zod";

const LANGUAGE = z.enum(["typescript", "javascript", "python", "go", "rust"]);

const projectSchema = z
  .object({
    name: z.string().min(1),
    languages: z.array(LANGUAGE).default([]),
  })
  .strict();

const ingestSchema = z
  .object({
    mode: z.enum(["watch", "manual"]).default("watch"),
    debounce_ms: z.number().int().nonnegative().default(600),
    ignore_extra: z.array(z.string()).default([]),
    inherit_gitignore: z.boolean().default(true),
    pause_during_git: z.boolean().default(true),
  })
  .strict();

const embedderSchema = z
  .object({
    profile: z.enum(["default", "tiny", "pro"]).default("default"),
    batch_size: z.number().int().min(1).default(16),
  })
  .strict();

const SCHEDULE_PATTERN = /^(nightly|manual|on_change_threshold:\d+)$/;
const clusterSchema = z
  .object({
    algorithm: z.enum(["louvain", "leiden"]).default("louvain"),
    schedule: z
      .string()
      .regex(SCHEDULE_PATTERN, "schedule must be 'nightly' | 'manual' | 'on_change_threshold:<N>'")
      .default("nightly"),
    resolution: z.number().positive().default(1.5),
    alpha: z.number().min(0).max(1).default(0.4),
    beta: z.number().min(0).max(1).default(0.05),
    gamma: z.number().min(0).max(1).default(0.4),
    min_weight: z.number().min(0).max(1).default(0.3),
  })
  .strict();

const skillEmitterSchema = z
  .object({
    enabled: z.boolean().default(true),
    seed_on_init: z.boolean().default(true),
    min_size: z.number().int().min(1).default(3),
    max_size: z.number().int().min(1).default(50),
    min_age_days: z.number().int().nonnegative().default(2),
    expire_days: z.number().int().nonnegative().default(60),
  })
  .strict()
  .refine((v) => v.max_size >= v.min_size, {
    message: "max_size must be >= min_size",
    path: ["max_size"],
  })
  .refine((v) => v.expire_days >= v.min_age_days, {
    message: "expire_days must be >= min_age_days",
    path: ["expire_days"],
  });

const DEFAULT_MCP_EXPOSE = [
  "query",
  "context",
  "impact",
  "cluster",
  "skills_for",
  "recent_changes",
  "feedback",
] as const;

const mcpSchema = z
  .object({
    expose: z.array(z.string()).default([...DEFAULT_MCP_EXPOSE]),
    dangerous_tools_enabled: z.boolean().default(false),
    max_in_flight: z.number().int().min(1).default(4),
    max_response_kb: z.number().int().min(1).default(256),
  })
  .strict();

const proSchema = z
  .object({
    enabled: z.boolean().default(false),
    docker_compose_path: z.string().default("./pro/docker-compose.yml"),
  })
  .strict();

/**
 * Canonical schema for `.lodestone/lodestone.toml`.
 *
 * Notes:
 * - `[project].name` is required; everything else has defaults.
 * - `cypher` is intentionally NOT in the default `[mcp].expose`. Operators must
 *   opt in by adding "sql" (the post-Codex-001 rename of cypher) explicitly AND
 *   setting `[mcp].dangerous_tools_enabled = true`.
 * - All `[*]` blocks are optional; when omitted, defaults are applied.
 */
export const lodestoneConfigSchema = z
  .object({
    project: projectSchema,
    ingest: ingestSchema.default({} as never),
    embedder: embedderSchema.default({} as never),
    cluster: clusterSchema.default({} as never),
    skill_emitter: skillEmitterSchema.default({} as never),
    mcp: mcpSchema.default({} as never),
    pro: proSchema.default({} as never),
  })
  .strict();

export type LodestoneConfig = z.infer<typeof lodestoneConfigSchema>;

/** Parse a TOML-derived JS object. Throws ZodError on validation failure with field path info. */
export function parseLodestoneConfig(raw: unknown): LodestoneConfig {
  return lodestoneConfigSchema.parse(raw);
}
