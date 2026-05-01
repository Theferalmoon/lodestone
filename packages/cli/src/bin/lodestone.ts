#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Shebang entry. Thin: parses argv from process, calls main(), exits explicitly.
//
// Explicit `process.exit()` (not just `process.exitCode = code`) so the binary
// terminates promptly even if a future section keeps a timer or open handle
// alive (cli-progress + watcher + ingest worker all qualify). Trade-off: we
// must trust handlers to flush their own stdio before resolving.
import { main } from "../main.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    // main() catches its own throws; this fallback covers truly catastrophic
    // failures (e.g. import-time crash). ASCII-only output to stay readable
    // on Windows cmd.exe and NO_COLOR contexts.
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[err] Catastrophic CLI failure: ${detail}\n`);
    process.exit(1);
  }
);
