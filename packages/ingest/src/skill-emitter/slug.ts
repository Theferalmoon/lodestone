// SPDX-License-Identifier: Apache-2.0
// Lodestone — deterministic slug generator for SKILL.md directory names.

const MAX_SLUG_LEN = 60;

/**
 * Lowercase, hyphenate, strip non-[a-z0-9-]. Truncate to 60 chars.
 *
 * If empty after sanitization (e.g. all-symbol cluster name), fall back
 * to "cluster-" + first 8 chars of `fallbackId`.
 */
export function slugify(name: string, fallbackId: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    const id = fallbackId.replace(/[^a-z0-9]+/gi, "").slice(0, 8) || "unknown";
    return `cluster-${id.toLowerCase()}`;
  }
  return cleaned.length > MAX_SLUG_LEN ? cleaned.slice(0, MAX_SLUG_LEN).replace(/-+$/, "") : cleaned;
}
