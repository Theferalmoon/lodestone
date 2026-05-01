// SPDX-License-Identifier: Apache-2.0
// Public surface of @lodestone/cli — keeps the package importable from
// tests and from sibling packages without going through the bin entry.
export { main } from "./main.js";
export { dispatch, HANDLERS } from "./routing/dispatch.js";
export { SUBCOMMANDS, printTopLevelHelp, printVersionLine } from "./routing/help.js";
export { output, type OutputSink } from "./ui/output.js";
export { createProgressBar, type ProgressBar, type ProgressOptions } from "./ui/progress.js";
export { VERSION, COMMIT_HASH } from "./version.js";
