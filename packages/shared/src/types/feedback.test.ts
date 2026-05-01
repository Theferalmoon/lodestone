// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { FeedbackInput, FeedbackEvent } from "./feedback.js";
import { FEEDBACK_SIGNALS } from "./feedback.js";

describe("Feedback types", () => {
  it("FEEDBACK_SIGNALS lists the four allowed signals", () => {
    expect([...FEEDBACK_SIGNALS]).toEqual(["useful", "not_useful", "wrong", "stale"]);
  });

  it("FeedbackInput requires request_id (the post-Codex envelope dependency)", () => {
    const input: FeedbackInput = {
      tool: "query",
      request_id: "01927e8c-d4f2-7000-9c4a-000000000001",
      signal: "useful",
    };
    expect(input.request_id).toBeDefined();
    expect(input.note).toBeUndefined();
  });

  it("FeedbackEvent extends with recorded_at (server-stamped)", () => {
    const event: FeedbackEvent = {
      tool: "cluster",
      request_id: "01927e8c-d4f2-7000-9c4a-000000000002",
      signal: "wrong",
      note: "Returned wrong subsystem boundary.",
      recorded_at: "2026-05-01T03:30:00Z",
    };
    expect(event.recorded_at).toBe("2026-05-01T03:30:00Z");
    expect(event.note?.length).toBeGreaterThan(0);
  });
});
