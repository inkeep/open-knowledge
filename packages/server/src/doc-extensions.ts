/**
 * Supported markdown-family file extensions for content files.
 *
 * Ordered by precedence — earlier entries win when the same docName exists
 * with multiple extensions on disk. Precedence matches the industry convention
 * (Next.js, Astro, Fumadocs): `.mdx` is a strict superset of `.md`, so a
 * co-located `.mdx` is presumed to intentionally override the `.md`.
 *
 * The extension-less docName is what flows through the CRDT layer, MCP tools,
 * wiki-link resolution, and the backlink index. Persistence uses
 * `getDocExtension()` to decide which file extension to write to.
 *
 * Casing preservation: extensions are matched case-insensitively (`.MD` and
 * `.md` both qualify), but the actual on-disk casing observed at registration
 * time is stored verbatim and returned by `getDocExtension`. Persistence
 * therefore writes back to the same filename the user has on disk —
 * preventing a duplicate `Foo.md` from appearing alongside an existing
 * `Foo.MD` on case-sensitive filesystems (Linux ext4, APFS-case-sensitive).
 *
 * This module is intentionally small and free of I/O — it's consumed by the
 * file watcher, content filter, persistence, and API layers.
 */

import { extname } from 'node:path';
import {
  DEFAULT_DOC_EXTENSION,
  type DocExtension,
  SUPPORTED_DOC_EXTENSIONS,
} from '@inkeep/open-knowledge-core';

// Re-export the canonical core list so existing server-side importers
// (`./doc-extensions.ts`) keep working unchanged; core is the single source.
export { SUPPORTED_DOC_EXTENSIONS };

const DEFAULT_EXTENSION: DocExtension = DEFAULT_DOC_EXTENSION;

/** True when a path ends with any supported doc extension. */
export function isSupportedDocFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return (SUPPORTED_DOC_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * True when a path's extension matches the passed-in asset-extensions set.
 * Used by the file-watcher to admit asset files into the live event stream
 * without conflating them with markdown docs.
 *
 * The file-watcher passes `LINKABLE_ASSET_EXTENSIONS` (walk/index/watch gate),
 * which is a strict superset of `ASSET_EXTENSIONS` (serve gate).
 */
export function isSupportedAssetFile(path: string, assetExtensions: ReadonlySet<string>): boolean {
  const ext = extname(path).slice(1).toLowerCase();
  return ext.length > 0 && assetExtensions.has(ext);
}

/**
 * Strip a supported doc extension from a path. Returns the input unchanged if
 * no supported extension is present (so plain docNames pass through).
 */
export function stripDocExtension(path: string): string {
  const lower = path.toLowerCase();
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return path.slice(0, -ext.length);
  }
  return path;
}

/**
 * Canonicalize an extension string for precedence comparison.
 * Returns null when the input doesn't match any supported extension after
 * case-folding, so callers can reject early rather than store junk.
 */
function canonicalize(ext: string): DocExtension | null {
  const lower = ext.toLowerCase();
  if (lower === '.mdx') return '.mdx';
  if (lower === '.md') return '.md';
  return null;
}

/**
 * Return the precedence rank of an extension (lower = higher precedence).
 * Returns `Infinity` for unknown extensions so they never win.
 */
function rank(ext: DocExtension): number {
  return SUPPORTED_DOC_EXTENSIONS.indexOf(ext);
}

/**
 * In-memory map from extension-less docName to the on-disk extension as
 * observed (with original casing).
 *
 * Populated by the file watcher on initial scan and on create events. Read by
 * persistence, rescue-buffer, timeline query, and backlink-index when they
 * need to materialize a filesystem path from a docName.
 *
 * Scope: module-global singleton. Worktree isolation is enforced at the
 * content-dir boundary — each server process owns its own content dir and
 * therefore its own map.
 */
const docExtensionByName = new Map<string, string>();

/**
 * Record the on-disk extension for a docName. The caller passes the actual
 * observed extension (e.g. `.MD` or `.mdx`); the casing is preserved verbatim
 * so a later `getDocExtension` round-trip yields the same path on disk.
 *
 * Precedence is computed against the canonical (case-folded) form: `.mdx`
 * always wins over `.md` regardless of how either was cased on disk.
 *
 * Returns the effective extension after the call (with its original casing),
 * whether the stored mapping changed, and the shadowed extension if any.
 *
 * Throws when `observedExt` does not canonicalize to a supported extension —
 * callers must guard with `isSupportedDocFile` before calling.
 */
export function registerDocExtension(
  docName: string,
  observedExt: string,
): { effective: string; changed: boolean; shadowed: string | null } {
  const canonical = canonicalize(observedExt);
  if (!canonical) {
    throw new Error(`registerDocExtension: unsupported extension "${observedExt}"`);
  }
  const existing = docExtensionByName.get(docName);
  if (!existing) {
    docExtensionByName.set(docName, observedExt);
    return { effective: observedExt, changed: true, shadowed: null };
  }
  const existingCanonical = canonicalize(existing);
  if (!existingCanonical) {
    // Defensive: an entry stored without going through this function. Replace
    // it with the freshly observed (well-formed) extension and report change.
    docExtensionByName.set(docName, observedExt);
    return { effective: observedExt, changed: true, shadowed: existing };
  }
  if (existingCanonical === canonical) {
    // Same canonical extension — keep the first-observed casing untouched.
    // (Shouldn't normally drift since the watcher walks the same path.)
    return { effective: existing, changed: false, shadowed: null };
  }
  // Different canonical extensions — apply precedence.
  if (rank(canonical) < rank(existingCanonical)) {
    docExtensionByName.set(docName, observedExt);
    return { effective: observedExt, changed: true, shadowed: existing };
  }
  return { effective: existing, changed: false, shadowed: observedExt };
}

/**
 * Get the recorded extension for a docName, or the default (`.md`) when no
 * file has been observed for it yet (e.g. new-page creation via the API).
 *
 * Returns the actual on-disk casing — `Foo.MD` round-trips back to `.MD`,
 * so the persistence layer writes to the same filename rather than creating
 * a lowercase duplicate.
 */
export function getDocExtension(docName: string): string {
  return docExtensionByName.get(docName) ?? DEFAULT_EXTENSION;
}

/** Clear the recorded extension for a docName (e.g. on file delete). */
export function forgetDocExtension(docName: string): void {
  docExtensionByName.delete(docName);
}

/** Test hook — reset the map between tests that share the module scope. */
export function _resetDocExtensionsForTests(): void {
  docExtensionByName.clear();
}
