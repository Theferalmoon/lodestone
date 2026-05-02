// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { renderBody } from "../template.js";
import { mkCluster } from "./fixtures.js";

describe("renderBody", () => {
  it("starts with the cluster name as an H1", () => {
    const body = renderBody(mkCluster({ name: "Auth pipeline" }));
    expect(body.startsWith("# Auth pipeline\n")).toBe(true);
  });

  it("includes a 'Where it lives' section listing unique paths in PageRank order", () => {
    const body = renderBody(
      mkCluster({
        size: 6,
        paths: ["src/a.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/c.ts", "src/d.ts"],
      }),
    );
    expect(body).toMatch(/## Where it lives/);
    expect(body).toMatch(/- src\/a\.ts/);
    expect(body).toMatch(/- src\/b\.ts/);
    // Same path twice -> only one bullet.
    expect((body.match(/- src\/a\.ts/g) ?? []).length).toBe(1);
  });

  it("omits the bridges section when no bridges are present", () => {
    const body = renderBody(mkCluster({ size: 4, bridges: 0 }));
    expect(body).not.toMatch(/Notable bridges/);
  });

  it("includes a bridges section listing each bridge symbol", () => {
    const body = renderBody(mkCluster({ size: 4, bridges: 2 }));
    expect(body).toMatch(/## Notable bridges/);
  });

  it("includes a Naming evidence section for heuristic clusters", () => {
    const body = renderBody(mkCluster({ size: 4 }));
    expect(body).toMatch(/## Naming evidence/);
    expect(body).toMatch(/dominant verb: `verify`/);
  });

  it("ends with a single trailing newline (deterministic disk diff)", () => {
    const body = renderBody(mkCluster({ size: 4 }));
    expect(body.endsWith("\n")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(false);
  });

  it("is byte-stable for the same input", () => {
    const a = renderBody(mkCluster({ size: 5 }));
    const b = renderBody(mkCluster({ size: 5 }));
    expect(a).toBe(b);
  });
});
