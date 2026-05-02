// SPDX-License-Identifier: Apache-2.0
// Deterministic ~30-symbol "mini-repo" used as the v0 stand-in for the §20
// synthetic demo repo. The §07 spec's "matches recorded golden" test points
// at this fixture until §20 lands a real demo-repo golden.
//
// Topology — three modules with intentional centrality skew so PageRank
// produces a non-trivial, hand-defensible ranking:
//
//   src/utils.ts   — leaf utilities (`hash`, `clamp`, `slugify`, `now`)
//                    everything else calls into these → high PageRank.
//   src/db.ts      — `query`, `tx`, `connect` — middle tier, called by
//                    domain modules.
//   src/auth.ts    — `login`, `logout`, `verifyToken` — domain entry point.
//   src/orders.ts  — `createOrder`, `cancelOrder`, `listOrders` — domain.
//   src/api.ts     — `handleRequest`, `route` — top of the call graph
//                    (zero in-degree → low PageRank, high out-degree).

import type { Edge, LodestoneSymbol } from "@lodestone/shared";

function sym(
  filePath: string,
  name: string,
  kind: LodestoneSymbol["kind"] = "function",
): LodestoneSymbol {
  return {
    symbol: `${filePath}::${name}`,
    path: filePath,
    range: { start_line: 1, end_line: 1 },
    language: "typescript",
    kind,
  };
}

function call(fromPath: string, fromName: string, toPath: string, toName: string): Edge {
  return {
    from: `${fromPath}::${fromName}`,
    to: `${toPath}::${toName}`,
    kind: "calls",
    weight: 1,
  };
}

const UTILS = "src/utils.ts";
const DB = "src/db.ts";
const AUTH = "src/auth.ts";
const ORDERS = "src/orders.ts";
const API = "src/api.ts";

export const MINI_SYMBOLS: LodestoneSymbol[] = [
  // utils.ts
  sym(UTILS, "hash"),
  sym(UTILS, "clamp"),
  sym(UTILS, "slugify"),
  sym(UTILS, "now"),
  sym(UTILS, "assertNonEmpty"),
  // db.ts
  sym(DB, "connect"),
  sym(DB, "query"),
  sym(DB, "tx"),
  sym(DB, "close"),
  // auth.ts
  sym(AUTH, "login"),
  sym(AUTH, "logout"),
  sym(AUTH, "verifyToken"),
  sym(AUTH, "issueToken"),
  sym(AUTH, "hashPassword"),
  // orders.ts
  sym(ORDERS, "createOrder"),
  sym(ORDERS, "cancelOrder"),
  sym(ORDERS, "listOrders"),
  sym(ORDERS, "validateOrder"),
  sym(ORDERS, "computeTotal"),
  // api.ts
  sym(API, "handleRequest"),
  sym(API, "route"),
  sym(API, "respondJson"),
  sym(API, "respondError"),
  // misc
  sym(UTILS, "deepFreeze"),
  sym(UTILS, "isPlainObject"),
  sym(DB, "buildWhere"),
  sym(AUTH, "extractBearer"),
  sym(ORDERS, "applyDiscount"),
  sym(API, "parseQuery"),
  sym(API, "logRequest"),
];

// Deterministic edge list — every call is intentional. The shape is
// designed so `hash`, `query`, and `now` end up high-PageRank.
export const MINI_EDGES: Edge[] = [
  // db.ts depends on utils
  call(DB, "connect", UTILS, "now"),
  call(DB, "query", UTILS, "assertNonEmpty"),
  call(DB, "tx", DB, "query"),
  call(DB, "tx", UTILS, "now"),
  call(DB, "close", UTILS, "now"),
  call(DB, "buildWhere", UTILS, "isPlainObject"),
  call(DB, "query", DB, "buildWhere"),

  // auth.ts depends on db + utils
  call(AUTH, "login", AUTH, "verifyToken"),
  call(AUTH, "login", AUTH, "hashPassword"),
  call(AUTH, "login", DB, "query"),
  call(AUTH, "login", UTILS, "now"),
  call(AUTH, "logout", DB, "query"),
  call(AUTH, "logout", UTILS, "now"),
  call(AUTH, "verifyToken", UTILS, "hash"),
  call(AUTH, "verifyToken", AUTH, "extractBearer"),
  call(AUTH, "issueToken", UTILS, "hash"),
  call(AUTH, "issueToken", UTILS, "now"),
  call(AUTH, "hashPassword", UTILS, "hash"),

  // orders.ts depends on db + utils + auth
  call(ORDERS, "createOrder", ORDERS, "validateOrder"),
  call(ORDERS, "createOrder", ORDERS, "computeTotal"),
  call(ORDERS, "createOrder", DB, "tx"),
  call(ORDERS, "createOrder", UTILS, "slugify"),
  call(ORDERS, "createOrder", AUTH, "verifyToken"),
  call(ORDERS, "cancelOrder", DB, "query"),
  call(ORDERS, "cancelOrder", AUTH, "verifyToken"),
  call(ORDERS, "listOrders", DB, "query"),
  call(ORDERS, "listOrders", AUTH, "verifyToken"),
  call(ORDERS, "validateOrder", UTILS, "assertNonEmpty"),
  call(ORDERS, "computeTotal", UTILS, "clamp"),
  call(ORDERS, "computeTotal", ORDERS, "applyDiscount"),
  call(ORDERS, "applyDiscount", UTILS, "clamp"),

  // api.ts dispatches into auth + orders
  call(API, "handleRequest", API, "logRequest"),
  call(API, "handleRequest", API, "route"),
  call(API, "handleRequest", API, "respondJson"),
  call(API, "handleRequest", API, "respondError"),
  call(API, "route", AUTH, "login"),
  call(API, "route", AUTH, "logout"),
  call(API, "route", ORDERS, "createOrder"),
  call(API, "route", ORDERS, "cancelOrder"),
  call(API, "route", ORDERS, "listOrders"),
  call(API, "route", API, "parseQuery"),
  call(API, "respondJson", UTILS, "deepFreeze"),
  call(API, "respondError", UTILS, "now"),
  call(API, "logRequest", UTILS, "now"),
  call(API, "parseQuery", UTILS, "assertNonEmpty"),
];
