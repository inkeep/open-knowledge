/**
 * Eviction-policy tests for the shared snapshot blob-URL pool: past the
 * cap the oldest ORPHAN is revoked, but a URL still bound to any `<img>`
 * in the document (including `display:none` under a hidden Activity) is
 * requeued, never revoked out from under a displayed image.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __liveSnapshotUrlCount,
  __resetSnapshotUrlPoolForTests,
  MAX_LIVE_SNAPSHOT_URLS,
  releaseSnapshotUrl,
  retainSnapshotUrl,
} from './snapshot-url-pool.ts';

const revokeObjectURL = vi.fn();

describe('snapshot-url-pool', () => {
  beforeEach(() => {
    revokeObjectURL.mockClear();
    URL.revokeObjectURL = revokeObjectURL;
    __resetSnapshotUrlPoolForTests();
    revokeObjectURL.mockClear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    __resetSnapshotUrlPoolForTests();
    document.body.innerHTML = '';
  });

  test('past the cap, the oldest orphan is revoked', () => {
    for (let i = 0; i <= MAX_LIVE_SNAPSHOT_URLS; i++) {
      retainSnapshotUrl(`blob:orphan-${i}`);
    }
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:orphan-0');
    expect(__liveSnapshotUrlCount()).toBe(MAX_LIVE_SNAPSHOT_URLS);
  });

  test('a DOM-bound URL at the head is requeued, not revoked', () => {
    // The oldest entry is still shown by an <img> (a hidden Activity keeps
    // exactly this shape alive: DOM present, effects unmounted).
    const img = document.createElement('img');
    img.src = 'blob:still-shown';
    document.body.append(img);

    retainSnapshotUrl('blob:still-shown');
    for (let i = 0; i < MAX_LIVE_SNAPSHOT_URLS; i++) {
      retainSnapshotUrl(`blob:orphan-${i}`);
    }

    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:still-shown');
    // The orphan behind it was reclaimed instead.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:orphan-0');
  });

  test('a fully DOM-bound pool grows instead of revoking anything', () => {
    for (let i = 0; i <= MAX_LIVE_SNAPSHOT_URLS; i++) {
      const img = document.createElement('img');
      img.src = `blob:bound-${i}`;
      document.body.append(img);
      retainSnapshotUrl(`blob:bound-${i}`);
    }
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(__liveSnapshotUrlCount()).toBe(MAX_LIVE_SNAPSHOT_URLS + 1);
  });

  test('release removes the entry and revokes immediately', () => {
    retainSnapshotUrl('blob:replaced');
    releaseSnapshotUrl('blob:replaced');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:replaced');
    expect(__liveSnapshotUrlCount()).toBe(0);
  });
});
