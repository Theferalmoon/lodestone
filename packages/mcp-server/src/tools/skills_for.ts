// SPDX-License-Identifier: Apache-2.0
// `skills_for` tool — STUB. Real body lands in §16. ★ moat tool: returns
// codebase-specific skill cards ("this codebase does X this way") that the
// agent should consult before writing code in a given area.
import { z } from "zod";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "Return the most relevant skill cards for a coding task. Skill cards are codebase-specific patterns Lodestone learned from the project — error-handling conventions, dependency-injection style, testing idioms, naming conventions, lint-preferred imports — surfaced as concise, actionable summaries with example symbol references and a maturity tag (seed | emerging | mature). The agent should consult these BEFORE writing code so its output matches the project's house style. Top_k defaults to 5; semantic match against a task description.";

export const inputSchema = z.object({
  task_description: z.string().min(1, "task_description must be non-empty"),
  top_k: z.number().int().min(1).max(20).default(5),
  channel: z.literal("code").optional(),
});

export type SkillsForInput = z.infer<typeof inputSchema>;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}
