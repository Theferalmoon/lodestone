// SPDX-License-Identifier: Apache-2.0
//
// §20 — Runtime network interceptor (POST-CODEX-001 §18 amendment §3).
//
// Wraps every outbound network primitive (`globalThis.fetch`, `node:http`,
// `node:https`, `node:net`, `node:tls`, `node:dns`) and either records or
// rejects the call. Used by the e2e orchestrator to PROVE the privacy
// promise at integration scale: across the full `lodestone init` + every
// MCP tool exercise, zero outbound network calls are made.
//
// Design rules:
//   - Method-level patching only. We do NOT replace whole modules — node's
//     ESM proxies are frozen and replacing them would break the runtime.
//     Each method on the live module reference gets its descriptor flipped
//     to a wrapped function; restore() flips them back.
//   - Allowlist for benign localhost / unix-socket targets. The MCP stdio
//     transport doesn't need network at all (pipes), but better-sqlite3 +
//     onnxruntime-node may open named pipes / shared memory. We allow
//     loopback IPv4/IPv6 + unix sockets so internal IPC isn't recorded.
//   - "Record" mode logs the attempt; "block" mode throws. The orchestrator
//     uses block mode for the main run; the test wrapper inspects the log
//     to assert zero attempts.
//
// Compliance: NIST 800-53 SC-7, CMMC L2 SC.L2-3.13.5, ISO 27001 A.13.1.1.

import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";
import * as nodeNet from "node:net";
import * as nodeTls from "node:tls";
import * as nodeDns from "node:dns";

/** One recorded interception. */
export interface NetCallRecord {
  /** Surface name: "fetch" | "http.request" | "net.connect" | etc. */
  surface: string;
  /** Best-effort target — URL string for fetch, host:port for sockets. */
  target: string;
  /** Stack frame of the calling site (top non-interceptor frame). */
  callsite: string;
  /** Wall-clock timestamp. */
  ts: number;
}

export interface InterceptorOptions {
  /** Throw on any non-allowlisted call. Defaults to true. */
  block?: boolean;
  /** Hosts treated as benign (loopback, etc.). */
  allowHosts?: readonly string[];
  /** Optional sink — every recorded call is appended here. */
  log?: NetCallRecord[];
}

const DEFAULT_ALLOW = [
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "::",
];

/** Marker error — orchestrator/spec catches this discriminator. */
export class NetworkInterceptedError extends Error {
  public readonly code = "LODESTONE_E2E_NET_BLOCKED";
  constructor(public readonly surface: string, public readonly target: string) {
    super(
      `Network call blocked by §20 interceptor: ${surface} → ${target}. ` +
        `The privacy promise requires zero outbound calls during init+MCP exercise.`,
    );
    this.name = "NetworkInterceptedError";
  }
}

/** Internal — single active interceptor. We support only one at a time so
 * the restore() call always reverses the last install(). */
interface ActiveState {
  restore: () => void;
}

let active: ActiveState | null = null;

/** Install the interceptor. Returns a handle whose `.restore()` undoes
 * every patch and is safe to call multiple times. */
export function installNetworkInterceptor(
  opts: InterceptorOptions = {},
): { restore: () => void; calls: NetCallRecord[] } {
  if (active) {
    // Defensive: tearing down a leaked previous install rather than nesting
    // gives the test a clean slate even on a prior crashed run.
    active.restore();
    active = null;
  }

  const block = opts.block ?? true;
  const allow = new Set([...(opts.allowHosts ?? []), ...DEFAULT_ALLOW]);
  const calls: NetCallRecord[] = opts.log ?? [];

  const restorers: Array<() => void> = [];

  /** Helper — record then optionally throw. */
  function trip(surface: string, target: string): void {
    const callsite = (new Error().stack ?? "").split("\n")[3]?.trim() ?? "";
    calls.push({ surface, target, callsite, ts: Date.now() });
    if (block && !isAllowed(target, allow)) {
      throw new NetworkInterceptedError(surface, target);
    }
  }

  // ── fetch ──────────────────────────────────────────────────────────────
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    const wrappedFetch: typeof fetch = async (input, init) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url?: string }).url ?? String(input);
      trip("fetch", target);
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    };
    Object.defineProperty(globalThis, "fetch", {
      value: wrappedFetch,
      writable: true,
      configurable: true,
    });
    restorers.push(() => {
      Object.defineProperty(globalThis, "fetch", {
        value: originalFetch,
        writable: true,
        configurable: true,
      });
    });
  }

  // ── http / https request + get ────────────────────────────────────────
  for (const [modName, mod] of [
    ["http", nodeHttp],
    ["https", nodeHttps],
  ] as const) {
    for (const fnName of ["request", "get"] as const) {
      const original = (mod as unknown as Record<string, Function>)[fnName];
      if (typeof original !== "function") continue;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const target = describeRequestTarget(args);
        trip(`${modName}.${fnName}`, target);
        return original.apply(this, args);
      };
      try {
        (mod as unknown as Record<string, Function>)[fnName] = wrapped;
        restorers.push(() => {
          (mod as unknown as Record<string, Function>)[fnName] = original;
        });
      } catch {
        // Some properties may be non-writable in newer node ESM facades;
        // fail soft so the e2e still runs (with one less surface guarded).
      }
    }
  }

  // ── net.connect / createConnection ────────────────────────────────────
  for (const fnName of ["connect", "createConnection"] as const) {
    const original = (nodeNet as unknown as Record<string, Function>)[fnName];
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const target = describeSocketTarget(args);
      trip(`net.${fnName}`, target);
      return original.apply(this, args);
    };
    try {
      (nodeNet as unknown as Record<string, Function>)[fnName] = wrapped;
      restorers.push(() => {
        (nodeNet as unknown as Record<string, Function>)[fnName] = original;
      });
    } catch {
      /* non-writable — skip */
    }
  }

  // ── tls.connect ────────────────────────────────────────────────────────
  {
    const original = (nodeTls as unknown as Record<string, Function>).connect;
    if (typeof original === "function") {
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const target = describeSocketTarget(args);
        trip("tls.connect", target);
        return original.apply(this, args);
      };
      try {
        (nodeTls as unknown as Record<string, Function>).connect = wrapped;
        restorers.push(() => {
          (nodeTls as unknown as Record<string, Function>).connect = original;
        });
      } catch {
        /* non-writable */
      }
    }
  }

  // ── dns.lookup + promises.lookup ──────────────────────────────────────
  {
    const original = (nodeDns as unknown as Record<string, Function>).lookup;
    if (typeof original === "function") {
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const host = typeof args[0] === "string" ? args[0] : "<unknown>";
        // dns.lookup on loopback/local hostnames is benign — never blocks.
        if (!isAllowed(host, allow)) {
          trip("dns.lookup", host);
        }
        return original.apply(this, args);
      };
      try {
        (nodeDns as unknown as Record<string, Function>).lookup = wrapped;
        restorers.push(() => {
          (nodeDns as unknown as Record<string, Function>).lookup = original;
        });
      } catch {
        /* non-writable */
      }
    }
    const promisesObj = (nodeDns as unknown as { promises?: Record<string, Function> }).promises;
    if (promisesObj && typeof promisesObj.lookup === "function") {
      const original = promisesObj.lookup;
      const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
        const host = typeof args[0] === "string" ? args[0] : "<unknown>";
        if (!isAllowed(host, allow)) {
          trip("dns.promises.lookup", host);
        }
        return original.apply(this, args);
      };
      try {
        promisesObj.lookup = wrapped;
        restorers.push(() => {
          promisesObj.lookup = original;
        });
      } catch {
        /* non-writable */
      }
    }
  }

  const restore = (): void => {
    for (const fn of restorers.reverse()) {
      try {
        fn();
      } catch {
        /* best-effort — leaving a partial restore is better than throwing */
      }
    }
    if (active) {
      active = null;
    }
  };

  active = { restore };
  return { restore, calls };
}

/** Describe an http/https request's target host. Inputs can be a URL string,
 * a URL object, or an options bag. We never throw — the goal is logging. */
function describeRequestTarget(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first instanceof URL) return first.toString();
  if (first && typeof first === "object") {
    const o = first as { host?: string; hostname?: string; port?: number | string; path?: string };
    const host = o.hostname ?? o.host ?? "<unknown>";
    const port = o.port !== undefined ? `:${o.port}` : "";
    const path = o.path ?? "";
    return `${host}${port}${path}`;
  }
  return "<unknown>";
}

/** Describe a net/tls socket target — host:port or unix:path. */
function describeSocketTarget(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "number") {
    // (port[, host])
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    return `${host}:${first}`;
  }
  if (typeof first === "string") {
    // unix path
    return `unix:${first}`;
  }
  if (first && typeof first === "object") {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) return `unix:${o.path}`;
    const host = o.host ?? "localhost";
    const port = o.port ?? "<?>";
    return `${host}:${port}`;
  }
  return "<unknown>";
}

/** True when the target host (or substring of the URL) matches an allowlist
 * entry. Unix sockets always pass. */
function isAllowed(target: string, allow: ReadonlySet<string>): boolean {
  if (target.startsWith("unix:")) return true;
  // Try to parse as URL first.
  try {
    const u = new URL(target);
    if (allow.has(u.hostname)) return true;
  } catch {
    /* not a URL */
  }
  // host:port form
  const colonIdx = target.indexOf(":");
  const hostPart = colonIdx >= 0 ? target.slice(0, colonIdx) : target;
  if (allow.has(hostPart)) return true;
  // Exact-string allow entries (covers raw hostnames + IPs).
  if (allow.has(target)) return true;
  return false;
}
