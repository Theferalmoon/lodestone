// SPDX-License-Identifier: Apache-2.0
// Stub for the in-process worker lifecycle. Later sections (the watcher in
// §12, the MCP server scaffold in §13) wire actual start/stop/health here.
// Kept as a typed shape so importers in stub commands don't need to be
// rewritten when the body lands.

export type WorkerState = "stopped" | "starting" | "running" | "stopping";

export interface WorkerLifecycle {
  state(): WorkerState;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
}

/**
 * Returns a no-op lifecycle. Useful for unit tests of commands that don't
 * actually spawn anything yet. Real lifecycle wiring lands in §12 / §13.
 */
export function createNoopLifecycle(): WorkerLifecycle {
  let current: WorkerState = "stopped";
  return {
    state(): WorkerState {
      return current;
    },
    async start(): Promise<void> {
      current = "running";
    },
    async stop(): Promise<void> {
      current = "stopped";
    },
    async healthCheck(): Promise<boolean> {
      return current === "running";
    },
  };
}
