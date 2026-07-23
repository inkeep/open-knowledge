import { afterEach, describe, expect, test } from 'vitest';
import {
  __getMountIdRegistry,
  __resetMountIdRegistry,
  clearMountId,
  getMountId,
  setMountId,
} from './mount-id-registry';

describe('mount-id-registry', () => {
  afterEach(() => {
    __resetMountIdRegistry();
  });

  test('getMountId returns undefined for unknown docName', () => {
    expect(getMountId('nonexistent')).toBeUndefined();
  });

  test('setMountId then getMountId round-trips', () => {
    setMountId('doc-a', 'mount-id-a');
    expect(getMountId('doc-a')).toBe('mount-id-a');
  });

  test('setMountId is idempotent for the same pair', () => {
    setMountId('doc-a', 'id-1');
    setMountId('doc-a', 'id-1');
    expect(getMountId('doc-a')).toBe('id-1');
    expect(__getMountIdRegistry().size).toBe(1);
  });

  test('setMountId overwrites a previous mountId for the same docName', () => {
    setMountId('doc-a', 'id-1');
    setMountId('doc-a', 'id-2');
    expect(getMountId('doc-a')).toBe('id-2');
  });

  test('clearMountId removes the entry; subsequent get returns undefined', () => {
    setMountId('doc-a', 'id-1');
    clearMountId('doc-a');
    expect(getMountId('doc-a')).toBeUndefined();
  });

  test('clearMountId on unknown docName is a no-op', () => {
    clearMountId('nonexistent');
    expect(__getMountIdRegistry().size).toBe(0);
  });

  test('isolation between docNames', () => {
    setMountId('doc-a', 'id-a');
    setMountId('doc-b', 'id-b');
    expect(getMountId('doc-a')).toBe('id-a');
    expect(getMountId('doc-b')).toBe('id-b');
    clearMountId('doc-a');
    expect(getMountId('doc-a')).toBeUndefined();
    expect(getMountId('doc-b')).toBe('id-b');
  });
});
