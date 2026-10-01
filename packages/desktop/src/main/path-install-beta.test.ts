import * as nodeFs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathShimBlockLabel, pathShimFishConfFileName } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import { okManagedBinDirs } from '../shared/ok-child-env.ts';

vi.mock('../shared/desktop-variant.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/desktop-variant.ts')>();
  return { ...actual, DESKTOP_VARIANT: actual.DESKTOP_VARIANTS.beta };
});

import {
  ensureCliOnPath,
  pathInstallMarkerPath,
  removePathShimFromRcFiles,
} from './path-install.ts';

const BETA_EXE = '/Applications/OpenKnowledge Beta.app/Contents/MacOS/OpenKnowledge Beta';
const BETA_WRAPPER = '/Applications/OpenKnowledge Beta.app/Contents/Resources/cli/bin/ok.sh';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ok-beta-path-install-'));
}

describe('Beta CLI path install', () => {
  test('isolates marker, shims, environment, and rc block from Stable', async () => {
    const userHome = home();
    const zshrc = join(userHome, '.zshrc');
    const stableBlock = '# >>> open-knowledge cli >>>\nstable\n# <<< open-knowledge cli <<<\n';
    writeFileSync(zshrc, stableBlock);

    const result = await ensureCliOnPath({
      executablePath: BETA_EXE,
      isPackaged: true,
      platform: 'darwin',
      home: userHome,
      bundleVersion: '0.77.7-beta.0',
      env: { HOME: userHome, SHELL: '/bin/zsh' },
      spawn: async () => ({ code: 0, stdout: '/usr/bin:/bin', stderr: '' }),
      consentDecision: { status: 'granted', at: '2026-09-23T00:00:00.000Z' },
    });

    expect(result.status).toBe('installed');
    const betaRoot = join(userHome, '.ok-beta');
    expect(pathInstallMarkerPath(userHome)).toBe(join(betaRoot, 'path-install.json'));
    expect(readlinkSync(join(betaRoot, 'bin', 'ok-beta'))).toBe(BETA_WRAPPER);
    expect(readlinkSync(join(betaRoot, 'bin', 'open-knowledge-beta'))).toBe(BETA_WRAPPER);
    expect(readFileSync(join(betaRoot, 'env.sh'), 'utf8')).toContain('$' + '{HOME}/.ok-beta/bin');
    const installedRc = readFileSync(zshrc, 'utf8');
    expect(installedRc).toContain(stableBlock);
    expect(installedRc).toContain('# >>> open-knowledge beta cli >>>');

    expect(
      removePathShimFromRcFiles({
        home: userHome,
        platform: 'darwin',
        env: { SHELL: '/bin/zsh' },
      }),
    ).toMatchObject({ status: 'removed' });
    const removedRc = readFileSync(zshrc, 'utf8');
    expect(removedRc).toContain(stableBlock);
    expect(removedRc).not.toContain('open-knowledge beta cli');
    expect(existsSync(join(userHome, '.ok', 'path-install.json'))).toBe(false);
    expect(existsSync(join(userHome, '.ok'))).toBe(false);
  });

  test('moves an existing Beta install off ~/.ok/variants/beta and rewrites its rc block', async () => {
    const userHome = home();
    const legacyRoot = join(userHome, '.ok', 'variants', 'beta');
    const zshrc = join(userHome, '.zshrc');
    const bashProfile = join(userHome, '.bash_profile');
    const legacyBlock =
      '# >>> open-knowledge beta cli >>>\n[ -f "$HOME/.ok/variants/beta/env.sh" ] && . "$HOME/.ok/variants/beta/env.sh"\n# <<< open-knowledge beta cli <<<\n';
    const stableBlock = '# >>> open-knowledge cli >>>\nstable\n# <<< open-knowledge cli <<<\n';
    writeFileSync(zshrc, `${stableBlock}${legacyBlock}`);
    writeFileSync(bashProfile, 'export A=1\n');
    mkdirSync(join(legacyRoot, 'bin'), { recursive: true });
    symlinkSync(BETA_WRAPPER, join(legacyRoot, 'bin', 'ok-beta'));
    writeFileSync(join(userHome, '.ok', 'machine-id'), 'stable-id\n');
    writeFileSync(
      join(legacyRoot, 'path-install.json'),
      JSON.stringify({
        version: 1,
        installedAt: '2026-09-23T00:00:00.000Z',
        bundleVersion: '0.77.7-beta.0',
        bundleWrapperPath: BETA_WRAPPER,
        binDir: join(legacyRoot, 'bin'),
        envShimPath: join(legacyRoot, 'env.sh'),
        rcFiles: [zshrc],
        rcOptOuts: [bashProfile],
        pathDiscovery: null,
        extraSymlinks: [],
        consent: { status: 'granted', at: '2026-09-23T00:00:00.000Z' },
      }),
    );

    const result = await ensureCliOnPath({
      executablePath: BETA_EXE,
      isPackaged: true,
      platform: 'darwin',
      home: userHome,
      bundleVersion: '0.77.8-beta.0',
      env: { HOME: userHome, SHELL: '/bin/bash' },
      spawn: async () => ({
        code: 0,
        stdout: `/usr/bin:/bin:${join(legacyRoot, 'bin')}`,
        stderr: '',
      }),
    });

    expect(result.status).toBe('installed');
    const betaRoot = join(userHome, '.ok-beta');
    expect(readlinkSync(join(betaRoot, 'bin', 'ok-beta'))).toBe(BETA_WRAPPER);
    const marker = JSON.parse(readFileSync(join(betaRoot, 'path-install.json'), 'utf8'));
    expect(marker.rcOptOuts).toEqual([bashProfile]);
    expect(marker.consent.status).toBe('granted');
    const rc = readFileSync(zshrc, 'utf8');
    expect(rc).toContain(stableBlock);
    expect(rc).toContain('$HOME/.ok-beta/env.sh');
    expect(rc).not.toContain('variants/beta');
    expect(readFileSync(bashProfile, 'utf8')).toBe('export A=1\n');
    expect(existsSync(legacyRoot)).toBe(false);
    expect(readFileSync(join(userHome, '.ok', 'machine-id'), 'utf8')).toBe('stable-id\n');
  });
});

type FsOps = NonNullable<Parameters<typeof ensureCliOnPath>[0]['fs']>;

function fsWith(overrides: Partial<FsOps>): FsOps {
  return {
    existsSync: (path) => nodeFs.existsSync(path),
    readFileSync: (path, encoding) => nodeFs.readFileSync(path, encoding),
    writeFileSync: (path, content) => nodeFs.writeFileSync(path, content),
    mkdirSync: (path, options) => {
      nodeFs.mkdirSync(path, options);
    },
    unlinkSync: (path) => nodeFs.unlinkSync(path),
    symlinkSync: (target, path) => nodeFs.symlinkSync(target, path),
    renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
    readlinkSync: (path) => nodeFs.readlinkSync(path),
    lstatSync: (path) => nodeFs.lstatSync(path),
    rmSync: (path, options) => nodeFs.rmSync(path, options),
    ...overrides,
  };
}

function seedLegacyBetaInstall(userHome: string): { legacyRoot: string; zshrc: string } {
  const legacyRoot = join(userHome, '.ok', 'variants', 'beta');
  const zshrc = join(userHome, '.zshrc');
  writeFileSync(
    zshrc,
    '# >>> open-knowledge beta cli >>>\n[ -f "$HOME/.ok/variants/beta/env.sh" ] && . "$HOME/.ok/variants/beta/env.sh"\n# <<< open-knowledge beta cli <<<\n',
  );
  mkdirSync(join(legacyRoot, 'bin'), { recursive: true });
  writeFileSync(
    join(legacyRoot, 'path-install.json'),
    JSON.stringify({
      version: 1,
      installedAt: '2026-09-23T00:00:00.000Z',
      bundleVersion: '0.77.7-beta.0',
      bundleWrapperPath: BETA_WRAPPER,
      binDir: join(legacyRoot, 'bin'),
      envShimPath: join(legacyRoot, 'env.sh'),
      rcFiles: [zshrc],
      rcOptOuts: [],
      pathDiscovery: null,
      extraSymlinks: [],
      consent: { status: 'granted', at: '2026-09-23T00:00:00.000Z' },
    }),
  );
  return { legacyRoot, zshrc };
}

function launch(
  userHome: string,
  extra: Partial<Parameters<typeof ensureCliOnPath>[0]> = {},
): ReturnType<typeof ensureCliOnPath> {
  return ensureCliOnPath({
    executablePath: BETA_EXE,
    isPackaged: true,
    platform: 'darwin',
    home: userHome,
    bundleVersion: '0.77.8-beta.0',
    env: { HOME: userHome, SHELL: '/bin/zsh' },
    spawn: async () => ({ code: 0, stdout: '/usr/bin:/bin', stderr: '' }),
    ...extra,
  });
}

describe('Beta fish shim', () => {
  test('installs and removes the Beta fish file named by the shared layout', async () => {
    const userHome = home();
    const confD = join(userHome, '.config', 'fish', 'conf.d');
    const fishFile = join(confD, 'open-knowledge-beta.fish');
    expect(pathShimFishConfFileName('beta')).toBe('open-knowledge-beta.fish');

    const result = await launch(userHome, {
      env: { HOME: userHome, SHELL: '/usr/bin/fish' },
      consentDecision: { status: 'granted', at: '2026-09-23T00:00:00.000Z' },
    });

    expect(result.status).toBe('installed');
    expect(nodeFs.readdirSync(confD)).toEqual(['open-knowledge-beta.fish']);
    const fish = readFileSync(fishFile, 'utf8');
    expect(fish).toContain(`# >>> ${pathShimBlockLabel('beta')} >>>`);
    expect(fish).toContain('# >>> open-knowledge beta cli >>>');
    expect(fish).toContain('$HOME/.ok-beta/bin');

    expect(
      removePathShimFromRcFiles({
        home: userHome,
        platform: 'darwin',
        env: { SHELL: '/usr/bin/fish' },
      }),
    ).toMatchObject({ status: 'removed', strippedFiles: [fishFile] });
    expect(existsSync(fishFile)).toBe(false);
  });
});

describe('Beta legacy home cleanup', () => {
  test('a failed legacy removal names the directory and is retried on the next launch', async () => {
    const userHome = home();
    const { legacyRoot } = seedLegacyBetaInstall(userHome);
    const events: Array<Record<string, unknown>> = [];
    const logger = { event: (payload: Record<string, unknown>) => events.push(payload) };

    const first = await launch(userHome, {
      logger,
      fs: fsWith({
        rmSync: () => {
          throw new Error('EBUSY: resource busy');
        },
      }),
    });

    expect(first.status).toBe('installed');
    expect(existsSync(legacyRoot)).toBe(true);
    expect(events).toContainEqual({
      event: 'path-install-legacy-home-remove-failed',
      path: legacyRoot,
      error: 'EBUSY: resource busy',
    });

    events.length = 0;
    const rmCalls: string[] = [];
    const second = await launch(userHome, {
      logger,
      fs: fsWith({
        rmSync: (path, options) => {
          rmCalls.push(path);
          nodeFs.rmSync(path, options);
        },
      }),
    });

    expect(second.status).toBe('healthy-current');
    expect(rmCalls).toEqual([legacyRoot]);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(events.map((e) => e.event)).toContain('path-install-legacy-home-removed');
    expect(readFileSync(join(userHome, '.zshrc'), 'utf8')).toContain('$HOME/.ok-beta/env.sh');
  });

  test('the current marker wins over a leftover legacy marker, and the legacy home is cleared', async () => {
    const userHome = home();
    writeFileSync(join(userHome, '.zshrc'), '');
    const installed = await launch(userHome, {
      consentDecision: { status: 'granted', at: '2026-09-23T00:00:00.000Z' },
    });
    expect(installed.status).toBe('installed');
    const legacyRoot = join(userHome, '.ok', 'variants', 'beta');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(
      join(legacyRoot, 'path-install.json'),
      JSON.stringify({
        version: 1,
        installedAt: '2020-01-01T00:00:00.000Z',
        bundleVersion: 'legacy',
        bundleWrapperPath: '/stale/ok.sh',
        binDir: join(legacyRoot, 'bin'),
        envShimPath: join(legacyRoot, 'env.sh'),
        rcFiles: [],
        rcOptOuts: [],
        pathDiscovery: null,
        extraSymlinks: [],
        consent: { status: 'declined', at: '2020-01-01T00:00:00.000Z' },
      }),
    );

    const result = await launch(userHome, { bundleVersion: '0.77.9-beta.0' });

    expect(result.status).toBe('healthy-current');
    if (result.status !== 'healthy-current') throw new Error('unreachable');
    expect(result.marker.bundleVersion).toBe('0.77.8-beta.0');
    expect(result.marker.consent?.status).toBe('granted');
    expect(existsSync(legacyRoot)).toBe(false);
  });

  test('an install that fails before writing the new marker leaves the legacy home in place', async () => {
    const userHome = home();
    const { legacyRoot } = seedLegacyBetaInstall(userHome);
    const rmCalls: string[] = [];

    const result = await launch(userHome, {
      logger: { event: () => {} },
      fs: fsWith({
        symlinkSync: () => {
          throw new Error('EACCES: permission denied');
        },
        rmSync: (path) => {
          rmCalls.push(path);
        },
      }),
    });

    expect(result.status).toBe('failed-all');
    expect(rmCalls).toEqual([]);
    expect(existsSync(legacyRoot)).toBe(true);
    expect(existsSync(pathInstallMarkerPath(userHome))).toBe(false);
  });
});

function seedStuckBetaInstall(userHome: string): { legacyRoot: string; zshrc: string } {
  const seeded = seedLegacyBetaInstall(userHome);
  const bin = join(userHome, '.ok-beta', 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(BETA_WRAPPER, join(bin, 'ok-beta'));
  symlinkSync(BETA_WRAPPER, join(bin, 'open-knowledge-beta'));
  return seeded;
}

describe('Beta install interrupted after the new links were created', () => {
  test('a legacy marker never counts as healthy, so the new marker and rc block get written', async () => {
    const userHome = home();
    const { legacyRoot, zshrc } = seedStuckBetaInstall(userHome);

    const result = await launch(userHome, {
      logger: { event: () => {} },
      spawn: async () => ({
        code: 0,
        stdout: `/usr/bin:/bin:${join(userHome, '.ok-beta', 'bin')}`,
        stderr: '',
      }),
    });

    expect(result.status).toBe('installed');
    expect(existsSync(pathInstallMarkerPath(userHome))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
    const rc = readFileSync(zshrc, 'utf8');
    expect(rc).toContain('$HOME/.ok-beta/env.sh');
    expect(rc).not.toContain('variants/beta');
  });

  test('the legacy home survives a failed marker write and is cleared on the next launch', async () => {
    const userHome = home();
    const { legacyRoot } = seedStuckBetaInstall(userHome);
    const rmCalls: string[] = [];

    const failed = await launch(userHome, {
      logger: { event: () => {} },
      fs: fsWith({
        writeFileSync: (path, content) => {
          if (path === pathInstallMarkerPath(userHome)) throw new Error('ENOSPC: no space left');
          nodeFs.writeFileSync(path, content);
        },
        rmSync: (path) => {
          rmCalls.push(path);
        },
      }),
    });

    expect(failed.status).toBe('failed-all');
    expect(rmCalls).toEqual([]);
    expect(existsSync(legacyRoot)).toBe(true);

    const retried = await launch(userHome, { logger: { event: () => {} } });

    expect(retried.status).not.toBe('failed-all');
    expect(existsSync(pathInstallMarkerPath(userHome))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
  });
});

describe('Beta installer and runtime agree on the bin dir', () => {
  test('the marker, env.sh and rc block all name the dir the runtime puts on PATH', async () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    try {
      const userHome = home();
      writeFileSync(join(userHome, '.zshrc'), '');
      const result = await launch(userHome, {
        env: { HOME: userHome, SHELL: '/usr/bin/fish' },
        consentDecision: { status: 'granted', at: '2026-09-23T00:00:00.000Z' },
      });
      if (result.status !== 'installed') throw new Error(`unexpected ${result.status}`);
      const runtimeBin = okManagedBinDirs({ platform: 'darwin', home: userHome })[0];
      expect(runtimeBin).toBe(join(userHome, '.ok-beta', 'bin'));
      expect(result.marker.binDir).toBe(runtimeBin);
      const relative = runtimeBin?.slice(userHome.length);
      expect(readFileSync(result.marker.envShimPath, 'utf8')).toContain(`"$\{HOME}${relative}"`);
      expect(
        readFileSync(
          join(userHome, '.config', 'fish', 'conf.d', 'open-knowledge-beta.fish'),
          'utf8',
        ),
      ).toContain(`"$HOME${relative}"`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
