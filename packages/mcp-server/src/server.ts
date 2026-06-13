#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Lodestone MCP server — stdio bootstrap. Loads lodestone.toml, builds the
// active tool set from tools/index.ts, registers each with the SDK behind the
// in-flight cap + truncation guard + channel validator, then connects a
// StdioServerTransport. Tool handler bodies live in §14–§17; this file is the
// scaffold that picks them up automatically once the registry entries change.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";

import type { LodestoneConfig } from "@lodestone/shared";

import { assertLocalStdioTrust } from "./auth.js";
import {
  LODESTONE_CHANNEL_V0,
  validateChannel,
  wrapErr,
  type LodestoneToolResponseV13,
} from "./envelope.js";
import { BackpressureError, InflightCap } from "./inflight.js";
import { enforceMaxResponseKb } from "./truncate.js";
import { buildActiveRegistry, type ToolEntry } from "./tools/index.js";

export interface CreateServerOptions {
  config: LodestoneConfig;
  /** Override the SDK Server name; defaults to "lodestone". */
  serverName?: string;
  /** Override version string; defaults to package.json version (resolved by caller). */
  serverVersion?: string;
}

export interface CreatedServer {
  server: Server;
  inflight: InflightCap;
  /** Active tools, in alphabetical order — useful for tests/inspection. */
  activeTools: readonly ToolEntry[];
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/**
 * Construct the MCP `Server` instance with all active tools registered.
 * Pure setup — does NOT connect a transport. Tests can drive this directly;
 * `main()` calls it then attaches stdio.
 */
export function createServer(opts: CreateServerOptions): CreatedServer {
  assertLocalStdioTrust();

  const { config } = opts;
  const activeTools = buildActiveRegistry({
    expose: config.mcp.expose,
    dangerousToolsEnabled: config.mcp.dangerous_tools_enabled,
  });

  // §15 YELLOW fix (Codex impl-015): the `sql` tool's defense-in-depth handler
  // gate reads `LODESTONE_DANGEROUS_TOOLS` from the process env. The §13 spec
  // says the server entrypoint should set this from the parsed config — but
  // until v0.1.1 nothing actually wired it, so `tools/list` could surface
  // `sql` while every call returned "sql tool disabled". Wire it now: ON when
  // config.dangerous_tools_enabled, CLEARED otherwise (fail-closed across
  // restarts that toggle the flag off without the operator unsetting the env).
  if (config.mcp.dangerous_tools_enabled) {
    process.env.LODESTONE_DANGEROUS_TOOLS = "1";
  } else {
    delete process.env.LODESTONE_DANGEROUS_TOOLS;
  }

  // Defense-in-depth: every tool description MUST be ≥150 chars (Claude Code
  // tool-search retrieval contract). The CI test enforces this; failing here
  // at server construction time would be too late, but we belt-and-suspender
  // it with an assert so a runtime mis-edit doesn't ship a broken description.
  for (const t of activeTools) {
    if (t.description.length < 150) {
      throw new Error(
        `Tool '${t.name}' description is ${t.description.length} chars; minimum is 150 ` +
          `(Claude Code tool-search retrieval requires keyword density).`,
      );
    }
  }

  const inflight = new InflightCap(config.mcp.max_in_flight);

  const server = new Server(
    {
      name: opts.serverName ?? "lodestone",
      version: opts.serverVersion ?? readPackageVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // tools/list — return the active set, alphabetical, with descriptions.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: activeTools.map((t) => ({
        name: t.name,
        description: t.description,
        // v0.1.1: real zod-derived JSON-Schema-7 (closes impl-013 placeholder).
        // Each tool pre-computes `jsonSchema` at module load via
        // `toMcpInputSchema(inputSchema)`. Closed shape — `additionalProperties:
        // false` — so MCP clients (Claude Code, Cursor, Cline) get
        // schema-level validation UX, while the in-handler safeParse() remains
        // the trust boundary on the request path.
        inputSchema: t.jsonSchema,
      })),
    };
  });

  // tools/call — dispatch to the registry, gated by inflight + truncation.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = activeTools.find((t) => t.name === toolName);
    if (!tool) {
      const env = wrapErr<unknown>(
        `unknown or unregistered tool: ${toolName}`,
        LODESTONE_CHANNEL_V0,
      );
      return toMcpToolResult(env);
    }

    let slot: ReturnType<InflightCap["tryAcquire"]>;
    try {
      slot = inflight.tryAcquire();
    } catch (err) {
      if (err instanceof BackpressureError) {
        const env = wrapErr<unknown>(err.message, LODESTONE_CHANNEL_V0);
        env.backpressure = true;
        return toMcpToolResult(env);
      }
      throw err;
    }

    try {
      const args = (request.params.arguments ?? {}) as { channel?: unknown };
      try {
        validateChannel(args.channel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toMcpToolResult(wrapErr<unknown>(message, LODESTONE_CHANNEL_V0));
      }

      let envelope: LodestoneToolResponseV13<unknown>;
      try {
        envelope = await tool.handler(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        envelope = wrapErr<unknown>(message, LODESTONE_CHANNEL_V0);
      }

      const sized = enforceMaxResponseKb(envelope, config.mcp.max_response_kb);
      return toMcpToolResult(sized);
    } finally {
      slot.release();
    }
  });

  return { server, inflight, activeTools };
}

/** Convert our envelope into the MCP CallTool response shape (text content). */
function toMcpToolResult<T>(envelope: LodestoneToolResponseV13<T>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const text = JSON.stringify(envelope);
  return {
    content: [{ type: "text", text }],
    isError: (envelope.diagnostics.warnings ?? []).some((w) =>
      ["not_implemented", "index not ready, see lodestone status"].includes(w),
    )
      ? false // not_implemented is a normal stub response, not an error
      : undefined,
  };
}

/**
 * stdio entrypoint. Loads config from cwd, builds the server, drains in-flight
 * on SIGINT/SIGTERM (best-effort, max 5s).
 *
 * NOTE: this function is intentionally NOT exercised by unit tests — it owns
 * process-level concerns (signals, stdio binding) covered by the §20 e2e
 * suite. createServer() carries the unit-tested logic.
 */
/* c8 ignore start */
export async function main(): Promise<void> {
  // Lazy-load the TOML reader + config so unit tests of createServer() don't
  // pull in fs I/O. The CLI (§03/§04) supplies the loaded config; this is the
  // standalone-bin path.
  const { lodestoneConfigSchema } = await import("@lodestone/shared");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { parse: parseToml } = await import("smol-toml");

  const cfgPath = join(process.cwd(), ".lodestone", "lodestone.toml");
  const raw = readFileSync(cfgPath, "utf8");
  const parsed = parseToml(raw);
  const config = lodestoneConfigSchema.parse(parsed);

  const { server, inflight } = createServer({ config });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.stderr.write(`[lodestone-mcp] received ${signal}, draining...\n`);
    const deadline = Date.now() + 5000;
    while (inflight.inFlight() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run main() when invoked as a binary (bin entry). Module imports skip this.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/server.js") === true;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[lodestone-mcp] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
/* c8 ignore stop */
