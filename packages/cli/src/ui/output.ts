// SPDX-License-Identifier: Apache-2.0
// Friend-facing output helpers — info/success → stdout, warn/error → stderr,
// json() emits one parseable line. ASCII prefix tags work on Windows cmd.exe
// + NO_COLOR (no Unicode glyphs that would render as mojibake on cp437).
// Honors NO_COLOR via picocolors (which short-circuits when NO_COLOR is set).
import pc from "picocolors";

export interface OutputSink {
  /** Plain log to stdout. */
  info(msg: string): void;
  /** Green success message to stdout. */
  success(msg: string): void;
  /** Yellow warning to stderr. */
  warn(msg: string): void;
  /** Red error to stderr (no stack trace; stack is for `--debug` later). */
  error(msg: string): void;
  /** One line of valid JSON to stdout. No color, no decoration. */
  json(obj: unknown): void;
}

/**
 * Default sink wired to process.stdout/process.stderr via console.
 *
 * Prefix tags are intentionally ASCII (`[ok]`/`[warn]`/`[err]`) rather than
 * Unicode glyphs — on Windows cmd.exe with cp437 default codepage, Unicode
 * glyphs render as mojibake. picocolors strips the ANSI color when NO_COLOR
 * is set; the ASCII prefix remains visible (we want a marker, not noise).
 */
export const output: OutputSink = {
  info(msg: string): void {
    console.log(msg);
  },
  success(msg: string): void {
    console.log(pc.green("[ok]") + " " + msg);
  },
  warn(msg: string): void {
    console.error(pc.yellow("[warn]") + " " + msg);
  },
  error(msg: string): void {
    console.error(pc.red("[err]") + " " + msg);
  },
  json(obj: unknown): void {
    console.log(JSON.stringify(obj));
  },
};
