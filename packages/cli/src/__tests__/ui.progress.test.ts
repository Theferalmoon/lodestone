// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProgressBar } from "../ui/progress.js";

describe("createProgressBar", () => {
  let prevTTY: boolean | undefined;
  let prevNoColor: string | undefined;

  beforeEach(() => {
    prevTTY = process.stdout.isTTY;
    prevNoColor = process.env.NO_COLOR;
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: prevTTY, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it("returns a no-op bar in non-TTY contexts", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const bar = createProgressBar({ label: "Test" });
    // Should accept update + finish without throwing or printing
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => {
      bar.update(0, 10);
      bar.update(5, 10);
      bar.finish();
    }).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("returns a no-op bar when NO_COLOR is set", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "1";
    const bar = createProgressBar({ label: "Test" });
    expect(() => {
      bar.update(0, 1);
      bar.finish();
    }).not.toThrow();
  });

  it("force=true returns a TTY bar even in non-TTY (smoke — bar just doesn't throw)", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    delete process.env.NO_COLOR;
    const bar = createProgressBar({ label: "Test", force: true });
    // cli-progress writes to stderr; we don't assert on output, just that
    // the bar lifecycle is callable without throwing.
    expect(() => {
      bar.update(0, 10);
      bar.update(5, 10);
      bar.update(10, 10);
      bar.finish();
      // calling finish twice is a no-op (started flag prevents double-stop)
      bar.finish();
    }).not.toThrow();
  });
});
