import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createTempDirFactory } from '../../../../test-support/temp-dir.test-helper.ts';
import {
  computePathInstallDescriptor,
  ensureCliOnPath,
  isPathShimInstalled,
  pathInstallMarkerPath,
  removePathShimFromRcFiles,
} from './path-install.ts';

const makeTempDir = createTempDirFactory(afterAll);
const DECLINED = { status: 'declined', at: '2026-07-02T00:00:00.000Z' } as const;
const GRANTED = { status: 'granted', at: '2026-07-02T00:00:00.000Z' } as const;
type Options = Parameters<typeof ensureCliOnPath>[0];

function linuxOptions(home: string, xdg?: string): Options {
  return {
    executablePath: '/opt/OpenKnowledge/openknowledge',
    isPackaged: true,
    platform: 'linux',
    home,
    bundleVersion: '0.5.0-test',
    env: { HOME: home, SHELL: '/bin/bash', XDG_CONFIG_HOME: xdg },
    spawn: async () => ({ code: 0, stdout: '/usr/bin:/bin', stderr: '' }),
    logger: { event: () => {} },
  };
}

async function seedLegacy(home: string) {
  const options = linuxOptions(home);
  expect((await ensureCliOnPath(options)).status).toBe('installed-silent');
  const current = join(home, '.config', 'OpenKnowledge', 'path-install.json');
  const legacy = join(home, 'Library', 'Application Support', 'OpenKnowledge', 'path-install.json');
  const marker = {
    ...JSON.parse(fs.readFileSync(current, 'utf8')),
    consent: DECLINED,
    rcOptOuts: [join(home, '.bashrc')],
    futureField: 'preserved',
  };
  const bytes = `${JSON.stringify(marker, null, 2)}\n`;
  fs.writeFileSync(current, bytes);
  fs.mkdirSync(dirname(legacy), { recursive: true });
  fs.renameSync(current, legacy);
  return { options, current, legacy, marker, bytes };
}

describe('Stable Linux PATH markers', () => {
  test.each(['unset', 'empty', 'custom'])(
    'stores the marker under XDG with %s configuration',
    async (mode) => {
      const home = makeTempDir('ok-linux-marker-');
      const xdg = mode === 'custom' ? join(home, 'settings') : mode === 'empty' ? '' : undefined;
      const options = linuxOptions(home, xdg);
      const expected = join(xdg || join(home, '.config'), 'OpenKnowledge', 'path-install.json');
      expect(pathInstallMarkerPath(home, 'linux', options.env)).toBe(expected);
      expect((await ensureCliOnPath(options)).status).toBe('installed-silent');
      expect(JSON.parse(fs.readFileSync(expected, 'utf8')).version).toBe(1);
      expect(fs.existsSync(join(home, 'Library'))).toBe(false);
      expect((await ensureCliOnPath(options)).status).toBe('healthy-current');
    },
  );

  test('migrates legacy bytes once without changing consent, opt-outs or unknown fields', async () => {
    const home = makeTempDir('ok-linux-migrate-');
    const { options, current, legacy, bytes } = await seedLegacy(home);
    expect((await ensureCliOnPath(options)).status).toBe('healthy-current');
    expect(fs.readFileSync(current, 'utf8')).toBe(bytes);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(join(home, 'Library'))).toBe(false);
    expect(fs.existsSync(join(home, '.bashrc'))).toBe(false);
    expect((await ensureCliOnPath(options)).status).toBe('healthy-current');
    expect(fs.readFileSync(current, 'utf8')).toBe(bytes);
  });

  test('keeps nonempty legacy directories and their unrelated files', async () => {
    const home = makeTempDir('ok-linux-preserve-');
    const { options, current, legacy, bytes } = await seedLegacy(home);
    const unrelated = join(dirname(legacy), 'keep.txt');
    fs.writeFileSync(unrelated, 'not managed by OpenKnowledge');
    expect((await ensureCliOnPath(options)).status).toBe('healthy-current');
    expect(fs.readFileSync(current, 'utf8')).toBe(bytes);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('not managed by OpenKnowledge');
  });

  test('does not overwrite an existing current marker', async () => {
    const home = makeTempDir('ok-linux-current-');
    const { options, current, legacy, marker, bytes } = await seedLegacy(home);
    const currentBytes = JSON.stringify({ ...marker, futureField: 'current-wins' });
    fs.writeFileSync(current, currentBytes);
    expect((await ensureCliOnPath(options)).status).toBe('healthy-current');
    expect(fs.readFileSync(current, 'utf8')).toBe(currentBytes);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(bytes);
  });

  test('does not overwrite a current marker created between lookup and copy', async () => {
    const home = makeTempDir('ok-linux-race-');
    const { options, current, legacy, marker, bytes } = await seedLegacy(home);
    const currentBytes = JSON.stringify({ ...marker, futureField: 'other-writer' });
    const result = await ensureCliOnPath({
      ...options,
      fs: {
        ...fs,
        copyFileSync: (source, destination, flags) => {
          fs.writeFileSync(destination, currentBytes);
          fs.copyFileSync(source, destination, flags);
        },
      },
    });
    expect(result.status).toBe('healthy-current');
    expect(fs.readFileSync(current, 'utf8')).toBe(currentBytes);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(bytes);
  });

  test('continues with the migrated marker when legacy cleanup is denied', async () => {
    const home = makeTempDir('ok-linux-unlink-denied-');
    const { options, current, legacy, bytes } = await seedLegacy(home);
    const events: unknown[] = [];
    let unlinkAttempts = 0;
    const opts = {
      ...options,
      fs: {
        ...fs,
        unlinkSync: (path: string) => {
          if (path === legacy) {
            unlinkAttempts += 1;
            throw Object.assign(new Error('legacy cleanup denied'), { code: 'EACCES' });
          }
          fs.unlinkSync(path);
        },
      },
      logger: { event: (event: unknown) => events.push(event) },
    };
    expect((await ensureCliOnPath(opts)).status).toBe('healthy-current');
    expect(fs.readFileSync(current, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(bytes);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'path-install-legacy-marker-retained', path: legacy }),
    );
    expect((await ensureCliOnPath(opts)).status).toBe('healthy-current');
    expect(unlinkAttempts).toBe(1);
  });

  test('retains the legacy marker when the destination cannot be created', async () => {
    const home = makeTempDir('ok-linux-migrate-fail-');
    const { options, current, legacy, bytes } = await seedLegacy(home);
    fs.rmdirSync(dirname(current));
    fs.writeFileSync(dirname(current), 'existing file');
    expect((await ensureCliOnPath(options)).status).toBe('failed-all');
    expect(fs.readFileSync(legacy, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(dirname(current), 'utf8')).toBe('existing file');
  });

  test('Settings reads and updates the same custom-XDG marker as startup', async () => {
    const home = makeTempDir('ok-linux-settings-');
    const options = { ...linuxOptions(home, join(home, 'settings')), consentDecision: GRANTED };
    expect((await ensureCliOnPath(options)).status).toBe('installed');
    expect(computePathInstallDescriptor(options).alreadyInstalled).toBe(true);
    expect(isPathShimInstalled(options)).toBe(true);
    expect(removePathShimFromRcFiles(options).status).toBe('removed');
    expect(isPathShimInstalled(options)).toBe(false);
    const path = pathInstallMarkerPath(home, 'linux', options.env);
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).consent.status).toBe('declined');
    expect(fs.existsSync(join(home, 'Library'))).toBe(false);
  });
});
