import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  parseV1VersionFromLocation,
  probeV1UpgradeVersion,
  resolveV1UpgradeFeed,
  scanV1UpgradeImpact,
} from './v1-upgrade.ts';

const PROXY_BASE = 'https://openknowledge.ai/updates';

describe('resolveV1UpgradeFeed', () => {
  test.each([
    ['latest', undefined, 'darwin', 'arm64', 'v1-stable', `${PROXY_BASE}/v1-stable/latest-mac.yml`],
    ['latest', undefined, 'win32', 'x64', 'v1-stable', `${PROXY_BASE}/v1-stable/latest.yml`],
    [
      'latest',
      undefined,
      'linux',
      'arm64',
      'v1-stable',
      `${PROXY_BASE}/v1-stable/latest-linux-arm64.yml`,
    ],
    ['latest', undefined, 'linux', 'x64', 'v1-stable', `${PROXY_BASE}/v1-stable/latest-linux.yml`],
    [
      'beta',
      'beta-product',
      'darwin',
      'arm64',
      'v1-beta-product',
      `${PROXY_BASE}/v1-beta-product/beta-product-mac.yml`,
    ],
    [
      'beta',
      'beta-product',
      'win32',
      'x64',
      'v1-beta-product',
      `${PROXY_BASE}/v1-beta-product/beta-product.yml`,
    ],
    [
      'beta',
      'beta-product',
      'linux',
      'arm64',
      'v1-beta-product',
      `${PROXY_BASE}/v1-beta-product/beta-product-linux-arm64.yml`,
    ],
    [
      'beta',
      'beta-product',
      'linux',
      'x64',
      'v1-beta-product',
      `${PROXY_BASE}/v1-beta-product/beta-product-linux.yml`,
    ],
    ['beta', 'beta', 'darwin', 'arm64', 'v1-beta', `${PROXY_BASE}/v1-beta/beta-mac.yml`],
    ['beta', 'beta', 'win32', 'x64', 'v1-beta', `${PROXY_BASE}/v1-beta/beta.yml`],
    ['beta', 'beta', 'linux', 'arm64', 'v1-beta', `${PROXY_BASE}/v1-beta/beta-linux-arm64.yml`],
    ['beta', 'beta', 'linux', 'x64', 'v1-beta', `${PROXY_BASE}/v1-beta/beta-linux.yml`],
  ] as const)(
    'maps %s (%s) on %s/%s to %s',
    (buildChannel, betaChannel, platform, arch, channelSlug, manifestUrl) => {
      const target = resolveV1UpgradeFeed({
        proxyFeed: {
          base: PROXY_BASE,
          channels: new Set(['latest', 'beta']),
          betaChannel,
        },
        buildChannel,
        platform,
        arch,
        appVersion: '0.89.18',
      });
      expect(target).toEqual({
        channelSlug,
        feedUrl: `${PROXY_BASE}/${channelSlug}`,
        manifestUrl,
      });
    },
  );

  test('returns null when already running v1 or newer', () => {
    expect(
      resolveV1UpgradeFeed({
        proxyFeed: { base: PROXY_BASE, channels: new Set(['latest']) },
        buildChannel: 'latest',
        platform: 'darwin',
        arch: 'arm64',
        appVersion: '1.0.0',
      }),
    ).toBeNull();
  });

  test('returns null when proxyFeed omits the build channel', () => {
    expect(
      resolveV1UpgradeFeed({
        proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
        buildChannel: 'latest',
        platform: 'darwin',
        arch: 'arm64',
        appVersion: '0.89.18',
      }),
    ).toBeNull();
  });
});

describe('parseV1VersionFromLocation', () => {
  test('extracts stable and prerelease v1 versions from GitHub download redirects', () => {
    expect(
      parseV1VersionFromLocation(
        'https://github.com/inkeep/open-knowledge/releases/download/v1.0.0/latest-mac.yml',
      ),
    ).toBe('1.0.0');
    expect(
      parseV1VersionFromLocation(
        'https://github.com/inkeep/open-knowledge/releases/download/v1.0.0-beta.2/beta-product-mac.yml',
      ),
    ).toBe('1.0.0-beta.2');
  });

  test('rejects v0 redirects and missing locations', () => {
    expect(
      parseV1VersionFromLocation(
        'https://github.com/inkeep/open-knowledge/releases/download/v0.89.18/latest-mac.yml',
      ),
    ).toBeNull();
    expect(parseV1VersionFromLocation(null)).toBeNull();
    expect(parseV1VersionFromLocation('https://example.com/no-version')).toBeNull();
  });
});

describe('probeV1UpgradeVersion', () => {
  test('issues a manual-redirect HEAD request and returns available on a 302 v1 Location', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 302,
      headers: new Headers({
        location:
          'https://github.com/inkeep/open-knowledge/releases/download/v1.0.0/latest-mac.yml',
      }),
    }));

    const result = await probeV1UpgradeVersion(`${PROXY_BASE}/v1-stable/latest-mac.yml`, fetchMock);

    expect(result).toEqual({ kind: 'available', version: '1.0.0' });
    expect(fetchMock).toHaveBeenCalledWith(
      `${PROXY_BASE}/v1-stable/latest-mac.yml`,
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    );
  });

  test('returns dormant on HTTP 404', async () => {
    const result = await probeV1UpgradeVersion(`${PROXY_BASE}/v1-stable/latest-mac.yml`, () =>
      Promise.resolve({ status: 404, headers: new Headers() }),
    );
    expect(result).toEqual({ kind: 'dormant' });
  });

  test('returns error on 503, 200, unparseable 302 Location, and network failures', async () => {
    await expect(
      probeV1UpgradeVersion(`${PROXY_BASE}/v1-stable/latest-mac.yml`, () =>
        Promise.resolve({ status: 503, headers: new Headers() }),
      ),
    ).resolves.toEqual({ kind: 'error', reason: 'http-503' });

    await expect(
      probeV1UpgradeVersion(`${PROXY_BASE}/v1-stable/latest-mac.yml`, () =>
        Promise.resolve({ status: 200, headers: new Headers() }),
      ),
    ).resolves.toEqual({ kind: 'error', reason: 'http-200' });

    await expect(
      probeV1UpgradeVersion(`${PROXY_BASE}/v1-stable/latest-mac.yml`, () =>
        Promise.resolve({
          status: 302,
          headers: new Headers({ location: 'https://example.com/no-version' }),
        }),
      ),
    ).resolves.toEqual({ kind: 'error', reason: 'unparseable-location' });

    await expect(
      probeV1UpgradeVersion(`${PROXY_BASE}/v1-stable/latest-mac.yml`, () =>
        Promise.reject(new Error('ECONNREFUSED')),
      ),
    ).resolves.toEqual({ kind: 'error', reason: 'ECONNREFUSED' });
  });
});

describe('scanV1UpgradeImpact', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects .okignore files and autoSync via resolveRootAutoSyncMode without throwing on missing paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-v1-impact-'));
    createdDirs.push(root);

    const withIgnore = join(root, 'handbook');
    mkdirSync(withIgnore, { recursive: true });
    writeFileSync(join(withIgnore, '.okignore'), 'secrets/\n');

    const withAutoSync = join(root, 'notes');
    mkdirSync(join(withAutoSync, '.ok', 'local'), { recursive: true });
    writeFileSync(join(withAutoSync, '.ok', 'local', 'config.yml'), 'autoSync:\n  mode: full\n');

    const clean = join(root, 'clean');
    mkdirSync(clean, { recursive: true });

    const impact = scanV1UpgradeImpact([
      { path: withIgnore, name: 'engineering-handbook' },
      { path: withAutoSync, name: 'team-notes' },
      { path: join(root, 'does-not-exist'), name: 'ghost' },
      { path: clean, name: 'clean' },
    ]);

    expect(impact).toEqual({
      okignoreProjects: ['engineering-handbook'],
      hasGitProjects: true,
    });
  });

  test('respects local autoSync.mode=off overriding a committed default', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-v1-clean-'));
    createdDirs.push(root);

    const proj = join(root, 'local-only');
    mkdirSync(join(proj, '.ok', 'local'), { recursive: true });
    writeFileSync(join(proj, '.ok', 'config.yml'), 'autoSync:\n  default: full\n');
    writeFileSync(join(proj, '.ok', 'local', 'config.yml'), 'autoSync:\n  mode: off\n');

    const impact = scanV1UpgradeImpact([{ path: proj, name: 'local-only' }]);
    expect(impact).toEqual({ okignoreProjects: [], hasGitProjects: false });
  });

  test('caps okignoreProjects at five entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-v1-cap-'));
    createdDirs.push(root);

    const projects = Array.from({ length: 7 }, (_, i) => {
      const dir = join(root, `proj-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.okignore'), 'private/\n');
      return { path: dir, name: `proj-${i}` };
    });

    const impact = scanV1UpgradeImpact(projects);
    expect(impact.okignoreProjects).toHaveLength(5);
    expect(impact.okignoreProjects).toEqual(['proj-0', 'proj-1', 'proj-2', 'proj-3', 'proj-4']);
  });
});
