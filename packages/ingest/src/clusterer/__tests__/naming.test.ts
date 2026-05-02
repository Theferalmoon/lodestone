// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  composeName,
  dominantBasename,
  dominantVerb,
  splitIdent,
  tokenizeSymbol,
} from "../naming.js";

describe("splitIdent", () => {
  it("splits camelCase", () => {
    expect(splitIdent("issueToken")).toEqual(["issue", "Token"]);
  });
  it("splits snake_case", () => {
    expect(splitIdent("issue_token")).toEqual(["issue", "token"]);
  });
  it("splits kebab-case", () => {
    expect(splitIdent("issue-token")).toEqual(["issue", "token"]);
  });
});

describe("tokenizeSymbol", () => {
  it("extracts basename + parts from a qualified id", () => {
    const t = tokenizeSymbol("src/auth.ts::User::issueToken");
    expect(t.basename).toBe("auth");
    expect(t.parts).toEqual(["user", "issue", "token"]);
  });
});

describe("dominantVerb", () => {
  it("returns the most-frequent non-stoplist token with count > 1", () => {
    const symbols = [
      "src/auth.ts::login",
      "src/auth.ts::User::login",
      "src/auth.ts::User::logout",
      "src/auth.ts::verifyToken",
    ];
    expect(dominantVerb(symbols)).toBe("login");
  });
  it("ignores stoplist verbs (get/set/do/make/run/is/has/to)", () => {
    const symbols = [
      "src/u.ts::get",
      "src/u.ts::set",
      "src/u.ts::doThing",
      "src/u.ts::doOtherThing",
    ];
    // 'do' is stoplisted, 'thing' would be dominant if length >= 3
    expect(dominantVerb(symbols)).toBe("thing");
  });
  it("returns undefined when no token has count > 1", () => {
    const symbols = ["src/a.ts::foo", "src/b.ts::bar"];
    expect(dominantVerb(symbols)).toBeUndefined();
  });
});

describe("dominantBasename", () => {
  it("picks the most-frequent filename basename", () => {
    const symbols = [
      "src/auth.ts::login",
      "src/auth.ts::logout",
      "src/auth.ts::verify",
      "src/util.ts::pad",
    ];
    expect(dominantBasename(symbols)).toBe("auth");
  });
});

describe("composeName — auth-cluster invariant", () => {
  it("returns a name containing 'auth' for an all-auth cluster", () => {
    const symbols = [
      "src/auth.ts::login",
      "src/auth.ts::logout",
      "src/auth.ts::verifyToken",
      "src/auth.ts::issueToken",
      "src/auth.ts::hashPassword",
    ];
    const { name } = composeName({ anchor: symbols[0]!, members: symbols });
    expect(name).toContain("auth");
  });
});

describe("composeName fallbacks", () => {
  it("falls back to 'cluster-<basename>' when no verb dominates", () => {
    const symbols = [
      "src/parser.ts::a",
      "src/parser.ts::b",
      "src/parser.ts::c",
    ];
    const { name } = composeName({ anchor: symbols[0]!, members: symbols });
    expect(name).toMatch(/^cluster-parser$/);
  });
  it("falls back to 'cluster-<anchor>' when no basename and no verb", () => {
    // Symbols without a path basename + with unique tokens.
    const { name } = composeName({
      anchor: "::xyz",
      members: ["::xyz"],
    });
    expect(name).toBe("cluster-xyz");
  });
});
