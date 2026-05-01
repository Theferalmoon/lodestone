// SPDX-License-Identifier: Apache-2.0
// Re-exports the canonical zod schema from @lodestone/shared so CLI sites
// can import from one consistent path. No new schema here — single source
// of truth lives in @lodestone/shared/src/config/schema.ts.
export {
  lodestoneConfigSchema,
  parseLodestoneConfig,
  type LodestoneConfig,
} from "@lodestone/shared";
