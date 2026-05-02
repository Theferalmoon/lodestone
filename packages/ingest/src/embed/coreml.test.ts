// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  detectCoreMLCapable,
  isCoreMLEnabled,
  markCoreMLEnabled,
  markCoreMLUnavailable,
  preferredExecutionProviders,
  _resetCoreMLState,
} from "./coreml.js";

describe("detectCoreMLCapable", () => {
  let origPlatform: PropertyDescriptor | undefined;
  let origArch: PropertyDescriptor | undefined;

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    origArch = Object.getOwnPropertyDescriptor(process, "arch");
    _resetCoreMLState();
  });
  afterEach(() => {
    if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    if (origArch) Object.defineProperty(process, "arch", origArch);
    _resetCoreMLState();
  });

  it("returns true on darwin-arm64", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    expect(detectCoreMLCapable()).toBe(true);
  });

  it("returns false on darwin-x64 (Intel Mac)", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    expect(detectCoreMLCapable()).toBe(false);
  });

  it("returns false on linux-x64", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    expect(detectCoreMLCapable()).toBe(false);
  });

  it("returns false on linux-arm64", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    expect(detectCoreMLCapable()).toBe(false);
  });

  it("returns false on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    expect(detectCoreMLCapable()).toBe(false);
  });
});

describe("isCoreMLEnabled state machine", () => {
  beforeEach(() => _resetCoreMLState());
  afterEach(() => _resetCoreMLState());

  it("falls back to capability check before any load attempt", () => {
    // Without any load having happened, the live flag is null; we surface
    // the capability check (so doctor doesn't crash on first call).
    const expected = detectCoreMLCapable();
    expect(isCoreMLEnabled()).toBe(expected);
  });

  it("reflects markCoreMLEnabled() once a successful EP load has happened", () => {
    markCoreMLEnabled();
    expect(isCoreMLEnabled()).toBe(true);
  });

  it("reflects markCoreMLUnavailable() once the EP failed and we fell back", () => {
    markCoreMLUnavailable();
    expect(isCoreMLEnabled()).toBe(false);
  });
});

describe("preferredExecutionProviders", () => {
  let origPlatform: PropertyDescriptor | undefined;
  let origArch: PropertyDescriptor | undefined;

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    origArch = Object.getOwnPropertyDescriptor(process, "arch");
  });
  afterEach(() => {
    if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    if (origArch) Object.defineProperty(process, "arch", origArch);
  });

  it("on Apple Silicon: tries coreml then cpu", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    expect(preferredExecutionProviders()).toEqual(["coreml", "cpu"]);
  });

  it("on Linux: cpu only", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    expect(preferredExecutionProviders()).toEqual(["cpu"]);
  });
});
