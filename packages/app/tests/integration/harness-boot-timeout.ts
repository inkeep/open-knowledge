/**
 * Import-isolation shim: consumers import HARNESS_BOOT_TIMEOUT_MS from this
 * module (not directly from './test-harness') because Biome organizeImports
 * force-merges duplicate-source imports — a second `from './test-harness'`
 * line cannot pass lint, and merging into the existing import line would put
 * every consumer's harness import line in play for unrelated diffs. A
 * distinct specifier keeps the constant's import a standalone line.
 */
export { HARNESS_BOOT_TIMEOUT_MS } from './test-harness';
