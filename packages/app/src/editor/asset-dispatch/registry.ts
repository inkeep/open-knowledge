
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

  clearForTests(): void {
    this.byExt.clear();
    this.viewerUnregisterFns = new WeakMap();
  }

  get size(): number {
    return this.byExt.size;
  }
}

export const assetViewerRegistry = new AssetViewerRegistry();
