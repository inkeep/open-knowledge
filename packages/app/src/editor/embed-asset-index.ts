import {
  createBasenameIndex,
  extractAssetExtension,
  LINKABLE_ASSET_EXTENSIONS,
} from '@inkeep/open-knowledge-core';

const index = createBasenameIndex();
let indexed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function isLinkableAsset(path: string): boolean {
  const ext = extractAssetExtension(path);
  return ext !== null && LINKABLE_ASSET_EXTENSIONS.has(ext);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function setEmbedAssetPaths(paths: Iterable<string>): void {
  const next = new Set<string>();
  for (const path of paths) if (isLinkableAsset(path)) next.add(path);
  if (sameSet(indexed, next)) return;
  indexed = next;
  index.clear();
  for (const path of next) index.add(path);
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (err) {
      console.error('[embed-asset-index] subscriber threw:', err);
    }
  }
}

export function resolveEmbedAsset(target: string, sourcePath: string): string | null {
  return index.resolveEmbed(target, sourcePath);
}

export function subscribeEmbedAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetEmbedAssetsForTests(): void {
  indexed = new Set();
  index.clear();
  listeners.clear();
}
