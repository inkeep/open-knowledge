/**
 * `AssetViewerRegistry` — module-level singleton that maps lowercased file
 * extensions to renderer-side viewers. Empty at landing; follow-up PRs
 * register PDF.js, image lightbox, video/audio inline.
 *
 * Contract: `lookup(ext)` returns a discriminated union so callers cannot
 * accidentally pass a possibly-undefined viewer into `.render()` (precedent
 * #19(b) — lookup discriminates on the type, no `!` assertion
 * required).
 *
 * Case discipline: both `register` and `lookup` lowercase inputs — matches
 * `classifyMarkdownHref` which emits `AssetLinkTarget.ext` already
 * normalized via `extractAssetExtension`. Belt-and-braces so a viewer
 * declaring `exts: ['PDF']` still finds itself on `lookup('pdf')`.
 *
 * Lifecycle:
 * - `register(viewer)` returns an `unregister: () => void` callback, matching
 *   the React 19 ref-callback cleanup idiom. Hot-reload + test code use it
 *   for cleanup.
 * - Ordering policy is **last-registered wins**. When a viewer instance other
 *   than the currently-registered one claims an existing extension, a
 *   structured `console.warn` is emitted naming the collision before the
 *   replacement happens.
 * - Both edges are idempotent. Re-registering the **same** viewer instance
 *   returns the existing unregister fn without warning. Calling the returned
 *   `unregister()` more than once is a benign no-op.
 */

import type { AssetViewer, AssetViewerLookupResult } from './types.ts';

export class AssetViewerRegistry {
  private readonly byExt = new Map<string, AssetViewer>();
  private viewerUnregisterFns = new WeakMap<AssetViewer, () => void>();

  register(viewer: AssetViewer): () => void {
    const existing = this.viewerUnregisterFns.get(viewer);
    if (existing) {
      return existing;
    }

    for (const ext of viewer.exts) {
      const key = ext.toLowerCase();
      const prior = this.byExt.get(key);
      if (prior && prior !== viewer) {
        console.warn(
          JSON.stringify({
            event: 'asset-viewer-collision',
            ext: key,
            priorExts: prior.exts,
            newExts: viewer.exts,
          }),
        );
      }
      this.byExt.set(key, viewer);
    }

    let unregistered = false;
    const unregister = (): void => {
      if (unregistered) return;
      unregistered = true;
      for (const ext of viewer.exts) {
        const key = ext.toLowerCase();
        if (this.byExt.get(key) === viewer) {
          this.byExt.delete(key);
        }
      }
      this.viewerUnregisterFns.delete(viewer);
    };
    this.viewerUnregisterFns.set(viewer, unregister);
    return unregister;
  }

  lookup(ext: string): AssetViewerLookupResult {
    const viewer = this.byExt.get(ext.toLowerCase());
    return viewer ? { ok: true, viewer } : { ok: false };
  }

  /**
   * Test-only — drop all registrations. Production code never calls this.
   * Named `clearForTests` rather than `reset` / `clear` so a stray call site
   * in production would stand out in code review.
   *
   * Also discards the per-viewer unregister-fn cache so a subsequent
   * `register(sameViewerInstance)` re-registers fresh rather than returning
   * the stale (now-orphaned) unregister fn.
   */
  clearForTests(): void {
    this.byExt.clear();
    this.viewerUnregisterFns = new WeakMap();
  }

  get size(): number {
    return this.byExt.size;
  }
}

/**
 * The singleton registry the dispatcher consults by default. Follow-up
 * viewer PRs register against this instance at module-init time:
 *
 * ```ts
 * import { assetViewerRegistry } from './asset-dispatch/registry';
 * const unregister = assetViewerRegistry.register(PdfJsViewer);
 * // ...later, e.g. in HMR cleanup:
 * unregister();
 * ```
 */
export const assetViewerRegistry = new AssetViewerRegistry();
