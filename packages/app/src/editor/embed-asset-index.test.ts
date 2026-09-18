import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEmbedAssetsForTests,
  resolveEmbedAsset,
  setEmbedAssetPaths,
  subscribeEmbedAssets,
} from './embed-asset-index';

afterEach(() => {
  __resetEmbedAssetsForTests();
});

describe('embed asset index', () => {
  it('resolves a bare file name to the asset that carries it', () => {
    setEmbedAssetPaths(['assets/pic.png', 'notes/meeting.md']);
    expect(resolveEmbedAsset('pic.png', '40-embed')).toBe('assets/pic.png');
    expect(resolveEmbedAsset('meeting.md', '40-embed')).toBeNull();
  });

  it('prefers the copy nearest the document when two share a name', () => {
    setEmbedAssetPaths(['archive/pic.png', 'notes/pic.png']);
    expect(resolveEmbedAsset('pic.png', 'notes/meeting')).toBe('notes/pic.png');
  });

  it('notifies subscribers only when the indexed set changes', () => {
    const listener = vi.fn();
    subscribeEmbedAssets(listener);
    setEmbedAssetPaths(['assets/pic.png']);
    setEmbedAssetPaths(['assets/pic.png', 'notes/meeting.md']);
    expect(listener).toHaveBeenCalledTimes(1);
    setEmbedAssetPaths([]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(resolveEmbedAsset('pic.png', 'notes/meeting')).toBeNull();
  });
});
