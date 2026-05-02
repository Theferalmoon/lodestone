// SPDX-License-Identifier: Apache-2.0
// CoreML execution-provider detection. Apple Silicon only; gracefully
// degrades to CPU if the EP fails to initialize at session-creation time.
//
// transformers.js v3+ accepts an executionProviders option; the dispatcher
// passes ["coreml", "cpu"] when this module reports CoreML available, then
// catches a session-creation failure and retries with ["cpu"], setting the
// process-scoped flag accordingly.

let coreMLEnabledFlag: boolean | null = null;

/** True iff the host is darwin-arm64 (Apple Silicon). */
function isAppleSilicon(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

/**
 * Pure capability check (no session creation). Returns true if the host can
 * theoretically use CoreML. The actual EP-creation attempt happens inside
 * the model loaders; on failure they call `markCoreMLUnavailable()`.
 */
export function detectCoreMLCapable(): boolean {
  return isAppleSilicon();
}

/**
 * Surface for callers (notably `lodestone doctor`). Reports the live state:
 * `null` until the first load attempt, `true`/`false` thereafter.
 */
export function isCoreMLEnabled(): boolean {
  // Until the first load happens we cannot answer authoritatively, but
  // the doctor / status surfaces want a deterministic boolean — return
  // the capability check result conservatively.
  return coreMLEnabledFlag ?? detectCoreMLCapable();
}

/** Called by a model loader after a successful CoreML EP session creation. */
export function markCoreMLEnabled(): void {
  coreMLEnabledFlag = true;
}

/** Called by a model loader when CoreML EP creation fails; we fell back. */
export function markCoreMLUnavailable(): void {
  coreMLEnabledFlag = false;
}

/** Reset for tests. Not part of the public surface. */
export function _resetCoreMLState(): void {
  coreMLEnabledFlag = null;
}

/**
 * The execution-provider list to pass to transformers.js for a given host.
 * On Apple Silicon: try CoreML first, fall back to CPU. Elsewhere: CPU only.
 */
export function preferredExecutionProviders(): readonly string[] {
  return detectCoreMLCapable() ? ["coreml", "cpu"] : ["cpu"];
}
