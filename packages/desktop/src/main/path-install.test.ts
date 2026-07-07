import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  computePathInstallDescriptor,
  computePathLeg,
  type EnsureCliOnPathResult,
  ensureCliOnPath,
  pathInstallMarkerPath,
} from './path-install.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
const WRAPPER = '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';

const GRANTED = { status: 'granted', at: '2026-07-02T00:00:00.000Z' } as const;
const DECLINED = { status: 'declined', at: '2026-07-02T00:00:00.000Z' } as const;

function home() {
  return mkdtempSync(join(tmpdir(), 'ok-path-install-'));
}

type EnsureOpts = Parameters<typeof ensureCliOnPath>[0];

/** Baseline opts: fresh packaged darwin launch; `~/.ok/bin` NOT yet on the
 *  discovered interactive PATH (the typical fresh machine, so the
 *  `canSkipRc` fast-path stays out of the way unless a test opts in). */
function baseOpts(h: string, overrides: Partial<EnsureOpts> = {}): EnsureOpts {
  return {
    executablePath: EXE,
    isPackaged: true,
    platform: 'darwin',
    home: h,
    bundleVersion: '0.5.0-test',
    env: { HOME: h, SHELL: '/bin/zsh' },
    spawn: async () => ({ code: 0, stdout: '/usr/bin:/bin', stderr: '' }),
    ...overrides,
  };
}

function readMarkerFile(h: string): Record<string, unknown> {
  return JSON.parse(readFileSync(pathInstallMarkerPath(h), 'utf8'));
}

describe('ensureCliOnPath — consent gate (rc files are never written without a consent signal)', () => {
  test('fresh launch without a decision: OK-owned steps land, no rc file is touched', async () => {
    const h = home();
    const result = await ensureCliOnPath(baseOpts(h));
    // Nothing user-visible happened — symlinks + shim live in OK's own
    // namespace, so no toast-worthy disclosure either.
    expect(result.status).toBe('installed-silent');
    expect(readlinkSync(join(h, '.ok', 'bin', 'ok'))).toBe(WRAPPER);
    expect(readlinkSync(join(h, '.ok', 'bin', 'open-knowledge'))).toBe(WRAPPER);
    expect(readFileSync(join(h, '.ok', 'env.sh'), 'utf8')).toContain(
      'export PATH="$' + '{HOME}/.ok/bin:$' + '{PATH}"',
    );
    // The sensitive step: no shell startup file is created or edited.
    expect(existsSync(join(h, '.zshrc'))).toBe(false);
    expect(existsSync(join(h, '.bash_profile'))).toBe(false);
    expect(existsSync(join(h, '.config', 'fish', 'conf.d', 'open-knowledge.fish'))).toBe(false);
    const marker = readMarkerFile(h);
    expect(marker.rcFiles).toEqual([]);
    expect(marker.consent).toBeUndefined();
  });

  test('an existing .zshrc stays byte-identical across undecided launches', async () => {
    const h = home();
    writeFileSync(join(h, '.zshrc'), 'export FOO=1\n');
    await ensureCliOnPath(baseOpts(h));
    await ensureCliOnPath(baseOpts(h));
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toBe('export FOO=1\n');
  });

  test('granted decision appends the managed block, records consent, and discloses the file', async () => {
    const h = home();
    const events: Array<Record<string, unknown>> = [];
    const result = await ensureCliOnPath(
      baseOpts(h, { consentDecision: GRANTED, logger: { event: (e) => events.push(e) } }),
    );
    expect(result.status).toBe('installed');
    if (result.status === 'installed') expect(result.summary).toContain('~/.zshrc');
    const zshrc = readFileSync(join(h, '.zshrc'), 'utf8');
    expect(zshrc).toContain('# >>> open-knowledge cli >>>');
    expect(zshrc).toContain('Delete this whole block to opt out');
    const marker = readMarkerFile(h);
    expect(marker.consent).toEqual({ status: 'granted', at: GRANTED.at });
    const granted = events.find((e) => e.event === 'path-install-consent-granted');
    expect(granted).toMatchObject({ source: 'dialog' });
  });

  test('startup → dialog grant → next startup: the confirm path flips a healthy-but-blockless marker', async () => {
    const h = home();
    // Boot 1: undecided — marker written, canonical symlinks healthy, no rc.
    await ensureCliOnPath(baseOpts(h));
    // Dialog confirm: the healthy-marker fast-path must NOT swallow the
    // grant (the marker is fully healthy with rcFiles: []).
    const granted = await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    expect(granted.status).toBe('installed');
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toContain('# >>> open-knowledge cli >>>');
    // Boot 2: recorded grant + healthy state → silent fast-path.
    const relaunch = await ensureCliOnPath(baseOpts(h));
    expect(relaunch.status).toBe('healthy-current');
  });

  test('declined decision records the choice and startup never appends afterwards', async () => {
    const h = home();
    const events: Array<Record<string, unknown>> = [];
    const declined = await ensureCliOnPath(
      baseOpts(h, { consentDecision: DECLINED, logger: { event: (e) => events.push(e) } }),
    );
    expect(declined.status).toBe('installed-silent');
    expect(existsSync(join(h, '.zshrc'))).toBe(false);
    expect(readMarkerFile(h).consent).toEqual({ status: 'declined', at: DECLINED.at });
    expect(events.find((e) => e.event === 'path-install-consent-declined')).toMatchObject({
      source: 'dialog',
    });
    const relaunch = await ensureCliOnPath(baseOpts(h));
    expect(relaunch.status).toBe('healthy-current');
    expect(existsSync(join(h, '.zshrc'))).toBe(false);
  });

  test('granted consent covers a NEW rc target on the next full install pass', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    // A .bash_profile appears after the grant. The healthy fast-path only
    // watches recorded rc files (unchanged behavior), so the new target is
    // wired on the next FULL pass — here an app update repointing the
    // wrapper — under the already-recorded consent, with no re-ask.
    writeFileSync(join(h, '.bash_profile'), 'export BAR=1\n');
    const fastPath = await ensureCliOnPath(baseOpts(h));
    expect(fastPath.status).toBe('healthy-current');
    expect(readFileSync(join(h, '.bash_profile'), 'utf8')).toBe('export BAR=1\n');

    const newExe = '/Users/someone/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
    const result = await ensureCliOnPath(baseOpts(h, { executablePath: newExe }));
    expect(result.status).toBe('installed');
    if (result.status === 'installed') expect(result.summary).toContain('~/.bash_profile');
    expect(readFileSync(join(h, '.bash_profile'), 'utf8')).toContain(
      '# >>> open-knowledge cli >>>',
    );
  });

  test('grandfather via healthy fast-path: pre-consent marker + healthy block ⇒ consent stamped, no rc write', async () => {
    const h = home();
    // Build a silent-era install: granted state, then strip the consent
    // field to simulate a marker written by a pre-consent build.
    await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    const markerPath = pathInstallMarkerPath(h);
    const preConsent = readMarkerFile(h);
    delete preConsent.consent;
    writeFileSync(markerPath, JSON.stringify(preConsent, null, 2));
    const zshrcBefore = readFileSync(join(h, '.zshrc'), 'utf8');

    const events: Array<Record<string, unknown>> = [];
    const result = await ensureCliOnPath(baseOpts(h, { logger: { event: (e) => events.push(e) } }));
    // No dialog-era nag, no removal, block untouched…
    expect(result.status).toBe('healthy-current');
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toBe(zshrcBefore);
    // …and the decision is now durable + attributed to grandfathering.
    const marker = readMarkerFile(h);
    expect((marker.consent as { status: string }).status).toBe('granted');
    expect(events.find((e) => e.event === 'path-install-consent-granted')).toMatchObject({
      source: 'grandfather',
    });
  });

  test('grandfather via full pass: dotfile-synced block with no marker ⇒ treated as consented', async () => {
    const h = home();
    // A managed block synced in from another machine's dotfiles — OK has
    // never run here (no marker, no symlinks).
    writeFileSync(
      join(h, '.zshrc'),
      '# >>> open-knowledge cli >>>\nstale contents\n# <<< open-knowledge cli <<<\n',
    );
    const events: Array<Record<string, unknown>> = [];
    const result = await ensureCliOnPath(baseOpts(h, { logger: { event: (e) => events.push(e) } }));
    // The block is ours to refresh — the rewrite is disclosed like any rc edit.
    expect(result.status).toBe('installed');
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toContain('$HOME/.ok/env.sh');
    expect((readMarkerFile(h).consent as { status: string }).status).toBe('granted');
    expect(events.find((e) => e.event === 'path-install-consent-granted')).toMatchObject({
      source: 'grandfather',
    });
  });

  test('a malformed consent field is tolerated and repaired from on-disk evidence', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    const markerPath = pathInstallMarkerPath(h);
    const corrupt = readMarkerFile(h);
    corrupt.consent = { status: 'maybe' };
    writeFileSync(markerPath, JSON.stringify(corrupt, null, 2));
    const events: Array<Record<string, unknown>> = [];
    const result = await ensureCliOnPath(baseOpts(h, { logger: { event: (e) => events.push(e) } }));
    expect(events.some((e) => e.event === 'path-install-marker-consent-invalid')).toBe(true);
    // Healthy block on disk ⇒ grandfather re-derives granted.
    expect(result.status).toBe('healthy-current');
    expect((readMarkerFile(h).consent as { status: string }).status).toBe('granted');
  });

  test('a marker carrying unknown future fields still fast-paths (additive round-trip)', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    const markerPath = pathInstallMarkerPath(h);
    const marker = readMarkerFile(h);
    marker.futureField = 'from-a-newer-build';
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    const result = await ensureCliOnPath(baseOpts(h));
    expect(result.status).toBe('healthy-current');
  });
});

describe('ensureCliOnPath', () => {
  test('healthy marker fast-path respects disk source of truth', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h));
    const healthy = await ensureCliOnPath(baseOpts(h));
    expect(healthy.status).toBe('healthy-current');
    unlinkSync(join(h, '.ok', 'bin', 'ok'));
    const repaired = await ensureCliOnPath(baseOpts(h));
    // Repairing only the symlink discloses nothing user-facing →
    // installed-silent, no toast. The rc gate stays closed (undecided).
    expect(repaired.status).toBe('installed-silent');
    expect(readlinkSync(join(h, '.ok', 'bin', 'ok'))).toBe(WRAPPER);
    expect(existsSync(join(h, '.zshrc'))).toBe(false);
  });

  test('honors removal of the managed block — records opt-out, never re-adds, summary discloses', async () => {
    const h = home();
    const run = (overrides: Partial<EnsureOpts> = {}) =>
      ensureCliOnPath(
        baseOpts(h, {
          spawn: async () => ({ code: 0, stdout: `${h}/.ok/bin:/usr/bin`, stderr: '' }),
          ...overrides,
        }),
      );
    const first = await run({ consentDecision: GRANTED });
    expect(first.status).toBe('installed');
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toContain('# >>> open-knowledge cli >>>');
    if (first.status === 'installed') expect(first.summary).toContain('~/.zshrc');

    // The user strips the block — the strongest opt-out signal. Consent
    // stays granted on the marker, but this file is never rewritten.
    writeFileSync(join(h, '.zshrc'), 'export FOO=1\n');
    const second = await run();
    expect(second.status).toBe('installed');
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).not.toContain('# >>> open-knowledge cli >>>');
    if (second.status === 'installed') expect(second.summary).toContain("won't be re-added");
    const marker = readMarkerFile(h);
    expect(marker.rcOptOuts).toEqual([join(h, '.zshrc')]);

    const third = await run();
    expect(third.status).toBe('healthy-current');
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).not.toContain('# >>> open-knowledge cli >>>');
  });

  test('does not seed symlinks into other PATH dirs and pads the zshrc block with blank lines', async () => {
    const h = home();
    const bin = join(h, 'bin');
    mkdirSync(bin);
    writeFileSync(join(h, '.zshrc'), 'export FOO=1');
    const result = await ensureCliOnPath(
      baseOpts(h, {
        consentDecision: GRANTED,
        spawn: async () => ({ code: 0, stdout: `${bin}:/usr/bin`, stderr: '' }),
      }),
    );
    expect(result.status).toBe('installed');
    // `bin` is a writable non-system PATH dir without `~/.ok/bin` on PATH —
    // the strongest temptation for the retired seeding behavior.
    expect(() => lstatSync(join(bin, 'ok'))).toThrow();
    expect(() => lstatSync(join(bin, 'open-knowledge'))).toThrow();
    const zshrc = readFileSync(join(h, '.zshrc'), 'utf8');
    expect(zshrc).toContain('export FOO=1\n\n# >>> open-knowledge cli >>>');
    expect(zshrc.endsWith('# <<< open-knowledge cli <<<\n\n')).toBe(true);
  });

  test('removes legacy marker-recorded extra symlinks, leaves re-pointed ones, retries failures', async () => {
    const h = home();
    const bin = join(h, 'bin');
    mkdirSync(bin);
    symlinkSync(WRAPPER, join(bin, 'ok'));
    symlinkSync('/elsewhere/ok.sh', join(bin, 'open-knowledge'));
    const markerPath = pathInstallMarkerPath(h);
    mkdirSync(dirname(markerPath), { recursive: true });
    const entry = (path: string) => ({
      path,
      target: WRAPPER,
      createdAt: '2026-05-01T00:00:00.000Z',
      kind: 'created' as const,
    });
    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 1,
        installedAt: '2026-05-01T00:00:00.000Z',
        bundleVersion: '0.4.0',
        bundleWrapperPath: WRAPPER,
        binDir: join(h, '.ok', 'bin'),
        envShimPath: join(h, '.ok', 'env.sh'),
        rcFiles: [],
        pathDiscovery: null,
        extraSymlinks: [
          entry(join(bin, 'ok')),
          entry(join(bin, 'open-knowledge')),
          entry(join(bin, 'gone')),
        ],
      }),
    );
    const events: Array<Record<string, unknown>> = [];
    const result = await ensureCliOnPath(
      baseOpts(h, {
        spawn: async () => ({ code: 0, stdout: `${h}/.ok/bin:/usr/bin`, stderr: '' }),
        logger: { event: (e) => events.push(e) },
      }),
    );
    expect(result.status).toBe('installed');
    // Removing legacy symlinks IS a user-facing disclosure — summary names it.
    if (result.status === 'installed') expect(result.summary).toContain('leftover ok symlink');
    // Still ours → removed; re-pointed → left on disk; missing → forgotten.
    expect(() => lstatSync(join(bin, 'ok'))).toThrow();
    expect(readlinkSync(join(bin, 'open-knowledge'))).toBe('/elsewhere/ok.sh');
    const marker = readMarkerFile(h);
    expect(marker.extraSymlinks).toEqual([]);
    expect(events.some((e) => e.event === 'path-install-extra-symlink-removed')).toBe(true);
  });

  test('skips outside packaged darwin bundle contexts', async () => {
    const h = home();
    const base = baseOpts(h, {
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(await ensureCliOnPath({ ...base, reclaimDisableEnv: '1' })).toEqual({
      status: 'skipped',
      reason: 'reclaim-disabled',
    });
    expect(await ensureCliOnPath({ ...base, platform: 'linux' })).toEqual({
      status: 'skipped',
      reason: 'platform',
    });
    expect(await ensureCliOnPath({ ...base, isPackaged: false })).toEqual({
      status: 'skipped',
      reason: 'dev-mode',
    });
    expect(await ensureCliOnPath({ ...base, executablePath: '/usr/local/bin/electron' })).toEqual({
      status: 'skipped',
      reason: 'bad-executable-path',
    });
  });

  test('returns failed-all instead of throwing when an fs operation fails', async () => {
    const h = home();
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const result = await ensureCliOnPath(
      baseOpts(h, {
        fs: {
          existsSync: () => false,
          readFileSync: () => '',
          writeFileSync: () => {},
          mkdirSync: () => {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          },
          unlinkSync: () => {},
          symlinkSync: () => {},
          renameSync: () => {},
          readlinkSync: () => {
            throw enoent();
          },
          lstatSync: () => {
            throw enoent();
          },
        },
        logger: { event: () => {} },
      }),
    );
    expect(result.status).toBe('failed-all');
    if (result.status === 'failed-all') expect(result.error).toContain('EACCES');
  });

  test('fish conf.d block uses fish syntax, not POSIX export', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    const fish = readFileSync(join(h, '.config', 'fish', 'conf.d', 'open-knowledge.fish'), 'utf8');
    expect(fish).toContain('# >>> open-knowledge cli >>>');
    expect(fish).toContain('set -gx PATH');
    expect(fish).not.toContain('export PATH');
  });

  test('app update repoints canonical symlinks to the new bundle wrapper', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h));
    const newExe = '/Users/someone/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
    const newWrapper =
      '/Users/someone/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';
    const result = await ensureCliOnPath(baseOpts(h, { executablePath: newExe }));
    // A pure symlink repoint touches nothing the user can see → installed-silent
    // so the startup toast stays silent instead of firing a sticky no-op on
    // every upgrade.
    expect(result.status).toBe('installed-silent');
    expect(readlinkSync(join(h, '.ok', 'bin', 'ok'))).toBe(newWrapper);
    expect(readlinkSync(join(h, '.ok', 'bin', 'open-knowledge'))).toBe(newWrapper);
  });
});

describe('computePathInstallDescriptor', () => {
  test('fresh zsh machine: touchable rc files listed tildified, nothing installed yet', () => {
    const h = home();
    const descriptor = computePathInstallDescriptor({ home: h, env: { SHELL: '/bin/zsh' } });
    expect(descriptor).toEqual({
      shellDetected: true,
      rcFilesToTouch: ['~/.zshrc', '~/.config/fish/conf.d/open-knowledge.fish'],
      alreadyInstalled: false,
    });
  });

  test('an existing .bash_profile joins the touch list; a non-zsh shell skips .zshrc creation', () => {
    const h = home();
    writeFileSync(join(h, '.bash_profile'), 'export BAR=1\n');
    const descriptor = computePathInstallDescriptor({ home: h, env: { SHELL: '/bin/bash' } });
    expect(descriptor.rcFilesToTouch).toEqual([
      '~/.bash_profile',
      '~/.config/fish/conf.d/open-knowledge.fish',
    ]);
  });

  test('a healthy managed block flips alreadyInstalled', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    const descriptor = computePathInstallDescriptor({ home: h, env: { SHELL: '/bin/zsh' } });
    expect(descriptor.alreadyInstalled).toBe(true);
    expect(descriptor.shellDetected).toBe(true);
  });

  test('granted consent without a block (user manages PATH themselves) still reads alreadyInstalled', async () => {
    const h = home();
    // Grant while `~/.ok/bin` is already on the discovered PATH after an
    // undecided boot → canSkipRc leaves every rc file untouched, but the
    // decision is recorded. The row must not re-solicit.
    await ensureCliOnPath(baseOpts(h));
    await ensureCliOnPath(
      baseOpts(h, {
        consentDecision: GRANTED,
        spawn: async () => ({ code: 0, stdout: `${h}/.ok/bin:/usr/bin`, stderr: '' }),
      }),
    );
    expect(existsSync(join(h, '.zshrc'))).toBe(false);
    const descriptor = computePathInstallDescriptor({ home: h, env: { SHELL: '/bin/zsh' } });
    expect(descriptor.alreadyInstalled).toBe(true);
  });

  test('opted-out rc files never re-enter the touch list; all-opted-out hides the row', async () => {
    const h = home();
    await ensureCliOnPath(baseOpts(h, { consentDecision: GRANTED }));
    // User strips the block → opt-out recorded on the next boot.
    writeFileSync(join(h, '.zshrc'), 'export FOO=1\n');
    unlinkSync(join(h, '.config', 'fish', 'conf.d', 'open-knowledge.fish'));
    await ensureCliOnPath(baseOpts(h));
    const descriptor = computePathInstallDescriptor({ home: h, env: { SHELL: '/bin/zsh' } });
    expect(descriptor.rcFilesToTouch).not.toContain('~/.zshrc');
    expect(descriptor.rcFilesToTouch).not.toContain('~/.config/fish/conf.d/open-knowledge.fish');
    expect(descriptor.shellDetected).toBe(false);
  });
});

describe('computePathLeg', () => {
  const marker = {} as Extract<EnsureCliOnPathResult, { status: 'installed' }>['marker'];

  test('installed → installed leg with its summary (the only success that toasts)', () => {
    expect(computePathLeg({ status: 'installed', marker, summary: 'Added ok to PATH.' })).toEqual({
      status: 'installed',
      summary: 'Added ok to PATH.',
    });
  });

  test('installed-silent → none (symlink-only repoint stays silent)', () => {
    expect(computePathLeg({ status: 'installed-silent', marker })).toEqual({ status: 'none' });
  });

  test('failed-all → failed leg carrying the error', () => {
    expect(computePathLeg({ status: 'failed-all', error: 'EACCES' })).toEqual({
      status: 'failed',
      summary: 'EACCES',
    });
  });

  test('skipped / healthy-current → none', () => {
    expect(computePathLeg({ status: 'skipped', reason: 'platform' })).toEqual({ status: 'none' });
    expect(computePathLeg({ status: 'healthy-current', marker })).toEqual({ status: 'none' });
  });
});
