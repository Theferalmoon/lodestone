// SPDX-License-Identifier: Apache-2.0
// Feedback tool types — agent signals about prior tool calls.

export const FEEDBACK_SIGNALS = ["useful", "not_useful", "wrong", "stale"] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];

/** Input shape for the `feedback` MCP tool. */
export interface FeedbackInput {
  /** Tool name from a prior call: "query" | "cluster" | "context" | etc. */
  tool: string;
  /** Required: matches the `request_id` field on the prior envelope. */
  request_id: string;
  signal: FeedbackSignal;
  /** Optional reason; truncated to 2 KB by the MCP server (sets diagnostics.truncated). */
  note?: string;
}

/** On-disk shape — extends FeedbackInput with the server-stamped recorded_at. */
export interface FeedbackEvent extends FeedbackInput {
  /** ISO-8601 timestamp written by the feedback tool, not the agent. */
  recorded_at: string;
}
