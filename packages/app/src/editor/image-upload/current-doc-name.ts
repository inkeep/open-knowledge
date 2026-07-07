/**
 * Resolve the currently-active document name from the URL hash. The hash
 * route (`#/foo/bar`) is the canonical source of truth for the active doc;
 * `internal-link-helpers.ts` reads it the same way for link
 * classification.
 *
 * A per-editor WeakMap (`editorDocName` in `extensions/doc-context.ts`)
 * resolves the active doc for callers that have an Editor instance — but
 * PropPanel's `runUpload` doesn't have one. The hash is stable, race-free
 * against editor mount/unmount, and aligned with how the rest of the link
 * layer already resolves the active doc.
 */

export function getCurrentDocName(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#\/([^?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
