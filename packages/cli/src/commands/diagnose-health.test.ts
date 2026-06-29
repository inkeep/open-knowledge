import { describe, expect, test } from 'bun:test';
import { runHealthChecks } from './diagnose-health.ts';
import type { CheckDefinition, CheckResult } from './diagnose-health-checks/index.ts';

function fixedCheck(name: CheckDefinition['name'], result: Partial<CheckResult>): CheckDefinition {
  return {
    name,
    run: async () => ({
      name,
      status: 'pass',
      summary: 'ok',
      ...result,
    }),
  };
}

function makeCapture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

const cwd = '/tmp/runHealthChecks-test';

describe('runHealthChecks', () => {
  test('returns 0 when every check passes; human-readable footer reflects it', async () => {
    const stdout = makeCapture();
    const exit = await runHealthChecks(
      { cwd },
      {
        stdout: stdout.write,
        checks: [
          fixedCheck('git', { status: 'pass', summary: 'git 2.42.0' }),
          fixedCheck('bun', { status: 'pass', summary: 'bun 1.3.13' }),
        ],
      },
    );
    expect(exit).toBe(0);
    const out = stdout.lines.join('\n');
    expect(out).toContain('git: git 2.42.0');
    expect(out).toContain('bun: bun 1.3.13');
    expect(out).toContain('All checks passed');
  });

  test('returns 1 when any check fails; footer surfaces error/warning counts', async () => {
    const stdout = makeCapture();
    const exit = await runHealthChecks(
      { cwd },
      {
        stdout: stdout.write,
        checks: [
          fixedCheck('git', { status: 'pass', summary: 'git 2.42.0' }),
          fixedCheck('bun', { status: 'fail', summary: 'bun missing' }),
          fixedCheck('config-yaml', { status: 'warn', summary: 'project not initialized' }),
        ],
      },
    );
    expect(exit).toBe(1);
    const out = stdout.lines.join('\n');
    expect(out).toContain('1 error, 1 warning');
  });

  test('returns 0 when only warns are present (warn does not fail; FR7 AC7.8)', async () => {
    const stdout = makeCapture();
    const exit = await runHealthChecks(
      { cwd },
      {
        stdout: stdout.write,
        checks: [fixedCheck('config-yaml', { status: 'warn', summary: 'project not initialized' })],
      },
    );
    expect(exit).toBe(0);
  });

  test('--check <name> runs only the named check', async () => {
    const stdout = makeCapture();
    let bunRan = false;
    const exit = await runHealthChecks(
      { cwd, check: 'git' },
      {
        stdout: stdout.write,
        checks: [
          fixedCheck('git', { status: 'pass', summary: 'git 2.42.0' }),
          {
            name: 'bun',
            run: async () => {
              bunRan = true;
              return { name: 'bun', status: 'pass', summary: 'bun 1.3.13' };
            },
          },
        ],
      },
    );
    expect(exit).toBe(0);
    expect(bunRan).toBe(false);
    expect(stdout.lines.join('\n')).toContain('git 2.42.0');
  });

  test('--check unknown returns 2 with stderr "unknown check"', async () => {
    const stdout = makeCapture();
    const stderr = makeCapture();
    const exit = await runHealthChecks(
      { cwd, check: 'banana' },
      {
        stdout: stdout.write,
        stderr: stderr.write,
        checks: [fixedCheck('git', { status: 'pass', summary: 'git' })],
      },
    );
    expect(exit).toBe(2);
    expect(stderr.lines.join('\n')).toContain('unknown check');
    expect(stdout.lines).toHaveLength(0);
  });

  test('--quiet suppresses stdout; exit code reflects fail', async () => {
    const stdout = makeCapture();
    const exit = await runHealthChecks(
      { cwd, quiet: true },
      {
        stdout: stdout.write,
        checks: [fixedCheck('git', { status: 'fail', summary: 'git missing' })],
      },
    );
    expect(exit).toBe(1);
    expect(stdout.lines).toHaveLength(0);
  });

  test('--json emits one JSON object per check, exit reflects status', async () => {
    const stdout = makeCapture();
    const exit = await runHealthChecks(
      { cwd, json: true },
      {
        stdout: stdout.write,
        checks: [
          fixedCheck('git', { status: 'pass', summary: 'git 2.42.0' }),
          fixedCheck('bun', {
            status: 'fail',
            summary: 'bun missing',
            remediation: 'install Bun',
            detail: 'extra',
          }),
        ],
      },
    );
    expect(exit).toBe(1);
    expect(stdout.lines).toHaveLength(2);
    const first = JSON.parse(stdout.lines[0] ?? '{}');
    const second = JSON.parse(stdout.lines[1] ?? '{}');
    expect(first).toEqual({ name: 'git', status: 'pass', summary: 'git 2.42.0' });
    expect(second).toEqual({
      name: 'bun',
      status: 'fail',
      summary: 'bun missing',
      remediation: 'install Bun',
      detail: 'extra',
    });
  });

  test('--verbose surfaces detail lines in human-readable output', async () => {
    const stdout = makeCapture();
    await runHealthChecks(
      { cwd, verbose: true },
      {
        stdout: stdout.write,
        checks: [
          fixedCheck('git', {
            status: 'pass',
            summary: 'git ok',
            detail: 'detected via Stage 1\nresolvedPath: /usr/bin/git',
          }),
        ],
      },
    );
    const out = stdout.lines.join('\n');
    expect(out).toContain('detected via Stage 1');
    expect(out).toContain('resolvedPath');
  });

  test('default (no --verbose) does NOT show detail lines but shows remediation on fail', async () => {
    const stdout = makeCapture();
    await runHealthChecks(
      { cwd },
      {
        stdout: stdout.write,
        checks: [
          fixedCheck('git', {
            status: 'fail',
            summary: 'git missing',
            remediation: 'sudo apt install git',
            detail: 'do-not-show',
          }),
        ],
      },
    );
    const out = stdout.lines.join('\n');
    expect(out).toContain('sudo apt install git');
    expect(out).not.toContain('do-not-show');
  });

  test('crashed check (runner surface) reports as fail', async () => {
    const stdout = makeCapture();
    const exit = await runHealthChecks(
      { cwd },
      {
        stdout: stdout.write,
        checks: [
          {
            name: 'git',
            run: async () => {
              throw new Error('boom');
            },
          },
        ],
      },
    );
    expect(exit).toBe(1);
    expect(stdout.lines.join('\n')).toContain('check crashed');
  });

  test('timed-out check reports as fail', async () => {
    const stdout = makeCapture();
    const exit = await runHealthChecks(
      { cwd },
      {
        stdout: stdout.write,
        checks: [
          {
            name: 'git',
            run: async () => new Promise(() => {}),
          },
        ],
        timeoutMs: 50,
      },
    );
    expect(exit).toBe(1);
    expect(stdout.lines.join('\n')).toContain('timed out');
  });
});
