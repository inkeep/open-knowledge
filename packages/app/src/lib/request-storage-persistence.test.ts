import { describe, expect, it, vi } from 'vitest';
import { requestStoragePersistence } from './request-storage-persistence';

describe('requestStoragePersistence', () => {
  it('calls navigator.storage.persist() when available and returns its result', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const nav = { storage: { persist } } as unknown as Navigator;

    const granted = await requestStoragePersistence(nav);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(granted).toBe(true);
  });

  it('returns false without throwing when the API is absent', async () => {
    const granted = await requestStoragePersistence({} as Navigator);
    expect(granted).toBe(false);
  });

  it('returns false without throwing when navigator is undefined', async () => {
    const granted = await requestStoragePersistence(undefined);
    expect(granted).toBe(false);
  });

  it('swallows a rejecting persist() and returns false', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('insecure context'));
    const nav = { storage: { persist } } as unknown as Navigator;

    const granted = await requestStoragePersistence(nav);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(granted).toBe(false);
  });
});
