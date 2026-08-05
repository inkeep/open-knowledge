import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_TIMEOUT_MS,
  DEFAULT_LOCAL_PACKAGED_APP,
  desktopLaunchOptions,
  executableForAppBundle,
  PACKAGED_APP_ENV,
  resolveDesktopTarget,
  UNPACKAGED_MAIN_ENTRY,
} from './launch-desktop';

const unpackaged = {
  mode: 'unpackaged' as const,
  targetPath: '/repo/out/main/index.js',
  exists: true,
  missingReason: 'x',
};
const packaged = {
  mode: 'packaged' as const,
  appPath: '/mnt/OpenKnowledge.app',
  targetPath: '/mnt/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
  exists: true,
  missingReason: 'x',
};

describe('resolveDesktopTarget', () => {
  it('resolves the unpackaged main entry when no packaged override is set', () => {
    const target = resolveDesktopTarget({ env: {} });
    expect(target.mode).toBe('unpackaged');
    expect(target.targetPath).toBe(UNPACKAGED_MAIN_ENTRY);
    expect(target.appPath).toBeUndefined();
  });

  it('treats an empty override as absent', () => {
    expect(resolveDesktopTarget({ env: { [PACKAGED_APP_ENV]: '' } }).mode).toBe('unpackaged');
  });

  it('resolves the bundle executable when the override names an .app', () => {
    const target = resolveDesktopTarget({ env: { [PACKAGED_APP_ENV]: '/mnt/OpenKnowledge.app' } });
    expect(target.mode).toBe('packaged');
    expect(target.appPath).toBe('/mnt/OpenKnowledge.app');
    expect(target.targetPath).toBe('/mnt/OpenKnowledge.app/Contents/MacOS/OpenKnowledge');
  });

  it('falls back to the local packaged build for packaged-only suites', () => {
    const target = resolveDesktopTarget({ env: {}, requirePackaged: true });
    expect(target.mode).toBe('packaged');
    expect(target.appPath).toBe(DEFAULT_LOCAL_PACKAGED_APP);
  });

  it('lets the override win over the packaged-only fallback', () => {
    const target = resolveDesktopTarget({
      env: { [PACKAGED_APP_ENV]: '/mnt/OpenKnowledge.app' },
      requirePackaged: true,
    });
    expect(target.appPath).toBe('/mnt/OpenKnowledge.app');
  });

  it('reports existence and a mode-appropriate skip reason', () => {
    const missing = resolveDesktopTarget({ env: { [PACKAGED_APP_ENV]: '/nope/Absent.app' } });
    expect(missing.exists).toBe(false);
    expect(missing.missingReason).toContain('/nope/Absent.app/Contents/MacOS/Absent');
    // The suite migrated off Bun; the skip hint must not send a reader to it.
    expect(resolveDesktopTarget({ env: {} }).missingReason).toContain('pnpm run build:desktop');
    expect(resolveDesktopTarget({ env: {} }).missingReason).not.toContain('bun run');
  });
});

describe('executableForAppBundle', () => {
  it('derives Contents/MacOS/<name> from the bundle name', () => {
    expect(executableForAppBundle('/Applications/OpenKnowledge.app')).toBe(
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
    );
  });
});

describe('desktopLaunchOptions', () => {
  it('unpackaged: main entry leads args and no executablePath is set', () => {
    const opts = desktopLaunchOptions({ target: unpackaged, args: ['--user-data-dir=/tmp/u'] });
    expect(opts.args).toEqual(['/repo/out/main/index.js', '--user-data-dir=/tmp/u']);
    expect('executablePath' in opts).toBe(false);
  });

  it('packaged: executablePath is set and the main entry is omitted from args', () => {
    const opts = desktopLaunchOptions({ target: packaged, args: ['--user-data-dir=/tmp/u'] });
    expect(opts.executablePath).toBe('/mnt/OpenKnowledge.app/Contents/MacOS/OpenKnowledge');
    expect(opts.args).toEqual(['--user-data-dir=/tmp/u']);
    expect(opts.args).not.toContain(UNPACKAGED_MAIN_ENTRY);
    expect(opts.args.some((a) => a.endsWith('out/main/index.js'))).toBe(false);
  });

  it('inherits the parent environment when the caller supplies none', () => {
    // Load-bearing: 8 smoke launch sites pass no env and depend on the parent
    // environment reaching the child untouched. Playwright REPLACES the child
    // env when the key is present, so the language pin below has to carry
    // `process.env` with it rather than stand alone. What must NOT appear is a
    // synthesized OK_DESKTOP_E2E_SMOKE — dialog-helpers and the instance-name
    // resolver read it unconditionally.
    const opts = desktopLaunchOptions({ target: unpackaged });
    expect(opts.env?.PATH).toBe(process.env.PATH);
    expect(opts.env?.OK_DESKTOP_E2E_SMOKE).toBe(process.env.OK_DESKTOP_E2E_SMOKE);
  });

  it('pins the interface language to English on every launch', () => {
    // These walk the real menu by exact English label; the app otherwise reads
    // the running user's own language preference off `~/.ok/global.yml`.
    expect(desktopLaunchOptions({ target: unpackaged }).env?.OK_LANG).toBe('en');
    expect(desktopLaunchOptions({ target: packaged }).env?.OK_LANG).toBe('en');
    expect(desktopLaunchOptions({ target: unpackaged, env: { OK_LANG: 'es' } }).env?.OK_LANG).toBe(
      'en',
    );
  });

  it('passes a supplied env through, over the inherited copy', () => {
    const env = { HOME: '/tmp/home', OK_DESKTOP_E2E_SMOKE: '1' };
    const opts = desktopLaunchOptions({ target: unpackaged, env });
    expect(opts.env?.HOME).toBe('/tmp/home');
    expect(opts.env?.OK_DESKTOP_E2E_SMOKE).toBe('1');
  });

  it('defaults the timeout to 30s and lets a caller override it', () => {
    expect(desktopLaunchOptions({ target: unpackaged }).timeout).toBe(DEFAULT_LAUNCH_TIMEOUT_MS);
    expect(DEFAULT_LAUNCH_TIMEOUT_MS).toBe(30_000);
    expect(desktopLaunchOptions({ target: unpackaged, timeout: 90_000 }).timeout).toBe(90_000);
  });

  it('does not alias the caller args array', () => {
    const args = ['--flag'];
    const opts = desktopLaunchOptions({ target: packaged, args });
    args.push('--mutated-after');
    expect(opts.args).toEqual(['--flag']);
  });
});

describe('no smoke file references __dirname without defining it', () => {
  // Regression guard for the launch-helper migration. `__dirname` is not a
  // runtime global under this package's "type": "module", but @types/node
  // declares it ambiently — so a stale reference typechecks clean, and
  // playwright.config.ts's testIgnore of `_*.e2e.ts` keeps CI from ever
  // importing the dev-only files where it bit. The failure is a
  // ReferenceError at module load, visible only to whoever runs the file
  // directly. A static check is the only tier that catches it.
  const SMOKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

  it.each(readdirSync(SMOKE_DIR).filter((f) => f.endsWith('.e2e.ts')))('%s', (file) => {
    const src = readFileSync(join(SMOKE_DIR, file), 'utf8');
    if (!src.includes('__dirname')) return;
    expect(src, `${file} uses __dirname without defining it`).toMatch(/const __dirname\s*=/);
  });
});
