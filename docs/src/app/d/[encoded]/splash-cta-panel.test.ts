import { describe, expect, test, vi } from 'vitest';

vi.mock('react', () => ({
  useEffect: () => {},
  useState: () => ['unknown', () => {}],
  createElement: () => null,
}));
vi.mock('./splash-cta-cluster', () => ({ SplashCtaCluster: () => null }));

import { splashPrimaryDownloadUrl } from './splash-cta-panel';

const SHARE_ROUTE = '/d/encoded-share/download';

describe('splashPrimaryDownloadUrl', () => {
  test('requests the picker through the share route without choosing an architecture', () => {
    expect(splashPrimaryDownloadUrl(SHARE_ROUTE, 'windows')).toBe(`${SHARE_ROUTE}?picker=1`);
    expect(splashPrimaryDownloadUrl(SHARE_ROUTE, 'linux')).toBe(`${SHARE_ROUTE}?picker=1`);
  });

  test('keeps the sole macOS build and SSR floor on the share-carrying route', () => {
    const mac = `${SHARE_ROUTE}?os=macos&arch=arm64&format=dmg`;
    expect(splashPrimaryDownloadUrl(SHARE_ROUTE, 'macos')).toBe(mac);
    expect(splashPrimaryDownloadUrl(SHARE_ROUTE, 'unknown')).toBe(mac);
  });
});
