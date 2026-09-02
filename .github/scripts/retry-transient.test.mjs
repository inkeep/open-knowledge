import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  backoffSeconds,
  DEFAULT_MAX_ATTEMPTS,
  isTransient,
  parseArgs,
  runWithRetry,
  TRANSIENT_SIGNATURES,
} from './retry-transient.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRelease = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'desktop-release.yml'),
  'utf8',
);

const scratch = mkdtempSync(join(tmpdir(), 'retry-transient-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => vi.restoreAllMocks();
});

const nodeCmd = (src) => ['node', '-e', src];

const run = (overrides) => {
  const lines = [];
  return runWithRetry({
    sleepFn: () => Promise.resolve(),
    log: (l) => lines.push(l),
    ...overrides,
  }).then((result) => ({ ...result, lines, log: lines.join('\n') }));
};

describe('the retry decision', () => {
  test('a command that succeeds runs exactly once', async () => {
    const r = await run({ command: nodeCmd('console.log("built")') });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  test('a NON-transient failure fails loud on the first attempt', async () => {
    const r = await run({
      command: nodeCmd('console.error("notarization status: Invalid");process.exit(1)'),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('non-transient');
    expect(r.attempts).toBe(1);
    expect(r.log).toContain('NON-transient');
  });

  test('a transient failure is retried and can succeed', async () => {
    const counter = join(scratch, 'flaky-count');
    writeFileSync(counter, '0');
    const r = await run({
      command: nodeCmd(
        `const fs=require('fs');const p=${JSON.stringify(counter)};` +
          `const n=Number(fs.readFileSync(p,'utf8'))+1;fs.writeFileSync(p,String(n));` +
          `if(n<2){console.error('⨯ socket hang up  failedTask=build');process.exit(1)}` +
          `console.log('packaged')`,
      ),
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(readFileSync(counter, 'utf8')).toBe('2');
  });

  test('a permanently transient failure stops at the attempt bound', async () => {
    const r = await run({
      command: nodeCmd('console.error("socket hang up");process.exit(1)'),
      maxAttempts: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('exhausted');
    expect(r.attempts).toBe(3);
    expect(r.log).toContain('retries are exhausted');
  });

  test('a command that cannot be spawned at all is not retried forever', async () => {
    const r = await run({ command: ['definitely-not-a-real-binary-xyz'], maxAttempts: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('non-transient');
  });

  test('--shell mode runs a compound command', async () => {
    const r = await run({ command: ['true && echo composed'], shell: true });
    expect(r.ok).toBe(true);
  });
});

describe('the transient allowlist', () => {
  test('matches the signature that blocked the 0.52.2 and 0.52.3 cuts', () => {
    expect(isTransient('⨯ socket hang up  failedTask=build stackTrace=RequestError: socket hang up')).toBe(
      true,
    );
  });

  test('matches case-insensitively and mid-line', () => {
    expect(isTransient('...Socket Hang Up...')).toBe(true);
    expect(isTransient('fetch failed: ECONNRESET')).toBe(true);
  });

  test('does NOT match real build, cert, or notarization failures', () => {
    for (const real of [
      'error TS2345: Argument of type string is not assignable',
      'The specified item could not be found in the keychain',
      'certificate has expired',
      'notarization failed with status: Invalid',
      'Command failed with exit code 1: tsc --noEmit',
      'Error: Cannot find module ./missing',
      'ENOSPC: no space left on device',
    ]) {
      expect(isTransient(real), `${real} must not be treated as transient`).toBe(false);
    }
  });

  test('handles empty and nullish output without throwing', () => {
    expect(isTransient('')).toBe(false);
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient(null)).toBe(false);
  });

  test('every signature is a real regex and none is so broad it matches bare text', () => {
    for (const sig of TRANSIENT_SIGNATURES) {
      expect(() => new RegExp(sig)).not.toThrow();
      expect(new RegExp(sig, 'i').test('Building desktop app')).toBe(false);
    }
  });
});

describe('backoff', () => {
  test('grows between attempts and stays bounded for the default attempt count', () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBeGreaterThan(backoffSeconds(1));
    const total = [...Array(DEFAULT_MAX_ATTEMPTS - 1).keys()]
      .map((i) => backoffSeconds(i + 1))
      .reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(10 * 60);
  });
});

describe('parseArgs', () => {
  const argv = (...rest) => ['node', 'x', ...rest];

  test('splits flags from the command at `--`', () => {
    const p = parseArgs(argv('--label', 'pkg (linux)', '--', 'pnpm', 'exec', 'electron-builder'));
    expect(p.label).toBe('pkg (linux)');
    expect(p.command).toEqual(['pnpm', 'exec', 'electron-builder']);
    expect(p.shell).toBe(false);
    expect(p.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  test('a flag-looking token after `--` belongs to the command', () => {
    const p = parseArgs(argv('--', 'pnpm', 'exec', 'electron-builder', '--linux', '--publish', 'never'));
    expect(p.command).toContain('--linux');
    expect(p.command).toContain('never');
  });

  test('requires a separator and a command', () => {
    expect(() => parseArgs(argv('--label', 'x'))).toThrow(/--/);
    expect(() => parseArgs(argv('--label', 'x', '--'))).toThrow(/no command/);
  });

  test('--shell demands exactly one command string', () => {
    expect(() => parseArgs(argv('--shell', '--', 'a', 'b'))).toThrow(/exactly one/);
    expect(parseArgs(argv('--shell', '--', 'a && b')).shell).toBe(true);
  });
});

describe('workflow wiring', () => {
  const step = (needle) => {
    const start = desktopRelease.indexOf(`- name: ${needle}`);
    if (start === -1) throw new Error(`desktop-release.yml has no step named ${needle}`);
    const rest = desktopRelease.slice(start);
    const end = rest.indexOf('\n      - name: ');
    return end === -1 ? rest : rest.slice(0, end);
  };

  test('step() throws on a missing name instead of returning a degenerate slice', () => {
    expect(() => step('This step does not exist')).toThrow(/has no step named/);
  });

  const PACKAGING_STEPS = [
    'Build + sign + notarize DMG/ZIP',
    'Package NSIS installers',
    'Package ${{ matrix.targets }}',
  ];

  test.each(PACKAGING_STEPS)('%s routes through the shared retry wrapper', (name) => {
    expect(step(name)).toContain('.github/scripts/retry-transient.mjs');
  });

  test.each(PACKAGING_STEPS)('%s defines its packaging command exactly once', (name) => {
    const invocations = step(name)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => l.includes('pnpm exec electron-builder'));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatch(/^\s*PKG_CMD=/);
  });

  test.each(PACKAGING_STEPS)('%s runs that command through the wrapper', (name) => {
    const body = step(name);
    expect(body).toContain('node "$WRAPPER"');
    expect(body).toContain('--shell -- "$PKG_CMD"');
  });

  test.each(PACKAGING_STEPS)('%s still packages when the wrapper is absent', (name) => {
    const body = step(name);
    expect(body).toContain('git -C "${GITHUB_WORKSPACE}" fetch --depth=1 origin "$GITHUB_SHA"');
    expect(body).toContain('bash -c "$PKG_CMD"');
    expect(body).toContain('::warning::Retry wrapper absent');
  });

  test('the retry allowlist is not duplicated back into the workflow', () => {
    expect(desktopRelease).not.toContain('transient_signatures=');
  });

  const preamble = (name) => {
    const body = step(name);
    const start = body.indexOf('WRAPPER="');
    const end = body.indexOf('PKG_CMD=');
    expect(start, `${name}: WRAPPER= not found`).toBeGreaterThan(-1);
    expect(end, `${name}: PKG_CMD= not found`).toBeGreaterThan(start);
    return body.slice(start, end);
  };

  let snippetSeq = 0;
  const runUnderErrexit = (snippet) => {
    const file = join(scratch, `preamble-${(snippetSeq += 1)}.sh`);
    writeFileSync(
      file,
      [
        'git() { case "$*" in *checkout*) return 1 ;; *) return 0 ;; esac; }',
        'GITHUB_WORKSPACE=/nonexistent-workspace',
        'GITHUB_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        snippet,
        'echo REACHED_FALLBACK',
      ].join('\n'),
    );
    return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      encoding: 'utf8',
    });
  };

  test.each(PACKAGING_STEPS)('%s reaches its fallback when sourcing fails', (name) => {
    const r = runUnderErrexit(preamble(name));
    expect(r.status, `sourcing failure must not abort the step:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('REACHED_FALLBACK');
  });

  test('the errexit harness actually discriminates (mutation control)', () => {
    const unExempt = [
      'WRAPPER="/nonexistent/retry-transient.mjs"',
      'if [[ ! -f "$WRAPPER" ]]; then',
      '  git fetch --depth=1 origin "$GITHUB_SHA" >/dev/null 2>&1 &&',
      '    git checkout "$GITHUB_SHA" -- .github/scripts/retry-transient.mjs 2>/dev/null',
      'fi',
    ].join('\n');
    const r = runUnderErrexit(unExempt);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('REACHED_FALLBACK');
  });
});
