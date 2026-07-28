import { describe, expect, test } from 'vitest';
import { DmgMountError, MOUNT_ERROR_CODES } from './dmg-mount.mjs';
import {
  annotationFor,
  classifyRun,
  EXIT_CODES,
  publishVerdict,
  runDriver,
  smokePackagedDmg,
  VERDICT,
} from './smoke-packaged-dmg.mjs';

const report = (stats) => ({ stats });

/** A mount stub that hands the callback a fixed app path. */
const mountOk = async (_dmg, cb) => cb('/tmp/copy/OpenKnowledge.app');
const mountThrows = (err) => async () => {
  throw err;
};

function deps({ mount = mountOk, run, read }) {
  return {
    withMountedDmg: mount,
    runPlaywright: run ?? (async () => ({ exitCode: 0 })),
    readReport: read ?? (async () => report({ expected: 16, unexpected: 0, flaky: 0, skipped: 0 })),
  };
}

describe('classifyRun', () => {
  test('all executed tests passing is a pass', () => {
    const v = classifyRun({
      runExitCode: 0,
      report: report({ expected: 16, unexpected: 0, flaky: 0, skipped: 2 }),
    });
    expect(v.verdict).toBe(VERDICT.pass);
    expect(v.reason).toContain('16');
  });

  test('a genuine test failure is a fail, not an error', () => {
    const v = classifyRun({
      runExitCode: 1,
      report: report({ expected: 14, unexpected: 2, flaky: 0, skipped: 0 }),
    });
    expect(v.verdict).toBe(VERDICT.fail);
    expect(v.reason).toContain('2 of 16');
  });

  test('flaky-but-eventually-green counts as executed and passes', () => {
    const v = classifyRun({
      runExitCode: 0,
      report: report({ expected: 15, unexpected: 0, flaky: 1, skipped: 0 }),
    });
    expect(v.verdict).toBe(VERDICT.pass);
  });

  test('zero executed tests is an error, never a pass', () => {
    // The adversarial case: a DMG so broken Electron never launches makes every
    // test skip, and a naive "no failures" reading would call that green.
    const v = classifyRun({
      runExitCode: 0,
      report: report({ expected: 0, unexpected: 0, flaky: 0, skipped: 16 }),
    });
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.verdict).not.toBe(VERDICT.pass);
    expect(v.reason).toContain('16 skipped');
  });

  test('a missing or unparseable report is an error', () => {
    expect(classifyRun({ runExitCode: 0, report: null }).verdict).toBe(VERDICT.error);
    expect(classifyRun({ runExitCode: 1, report: undefined }).verdict).toBe(VERDICT.error);
  });

  test('a runner that would not start is an error, not a fail', () => {
    const v = classifyRun({ runExitCode: 1, report: null, runnerError: 'spawn pnpm ENOENT' });
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('ENOENT');
  });

  test('a non-zero exit with no failing test is an error, not a fail', () => {
    const v = classifyRun({
      runExitCode: 3,
      report: report({ expected: 16, unexpected: 0, flaky: 0, skipped: 0 }),
    });
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('exited 3');
  });
});

describe('annotationFor', () => {
  test('pass is a notice; fail and error are warnings and read differently', () => {
    const pass = annotationFor(VERDICT.pass, 'r', '/a.dmg');
    const fail = annotationFor(VERDICT.fail, 'r', '/a.dmg');
    const error = annotationFor(VERDICT.error, 'r', '/a.dmg');
    expect(pass.startsWith('::notice::')).toBe(true);
    expect(fail.startsWith('::warning::')).toBe(true);
    expect(error.startsWith('::warning::')).toBe(true);
    expect(fail).not.toBe(error);
    expect(fail).toContain('FAILED');
    expect(error).toContain('ERRORED');
    expect(error).toContain('infrastructure');
    expect(fail).not.toContain('ERRORED');
  });
});

describe('publishVerdict', () => {
  test('writes verdict and reason to the step-output file when present', () => {
    const writes = [];
    publishVerdict(
      { verdict: VERDICT.fail, reason: 'two tests failed' },
      {
        env: { GITHUB_OUTPUT: '/tmp/out.txt' },
        appendFileSync: (p, s) => writes.push([p, s]),
      },
    );
    expect(writes).toEqual([['/tmp/out.txt', 'verdict=fail\nreason=two tests failed\n']]);
  });

  test('flattens newlines so the key=value format cannot be corrupted', () => {
    const writes = [];
    publishVerdict(
      { verdict: VERDICT.error, reason: 'line one\nline two' },
      { env: { GITHUB_OUTPUT: '/tmp/out.txt' }, appendFileSync: (_p, s) => writes.push(s) },
    );
    expect(writes[0]).toBe('verdict=error\nreason=line one line two\n');
  });

  test('echoes to stdout when there is no step-output file', () => {
    const out = [];
    publishVerdict(
      { verdict: VERDICT.pass, reason: 'ok' },
      { env: {}, writeStream: (s) => out.push(s) },
    );
    expect(out.join('')).toBe('verdict=pass\nreason=ok\n');
  });
});

describe('smokePackagedDmg', () => {
  test('passes the copied app path to the runner', async () => {
    let seen = null;
    const v = await smokePackagedDmg(
      '/tmp/OpenKnowledge.dmg',
      deps({
        run: async (appPath) => {
          seen = appPath;
          return { exitCode: 0 };
        },
      }),
    );
    expect(seen).toBe('/tmp/copy/OpenKnowledge.app');
    expect(v.verdict).toBe(VERDICT.pass);
  });

  test('a mount failure becomes an error verdict rather than throwing', async () => {
    const v = await smokePackagedDmg(
      '/tmp/broken.dmg',
      deps({
        mount: mountThrows(
          new DmgMountError(
            'hdiutil attach failed: no mountable file systems',
            MOUNT_ERROR_CODES.attachFailed,
          ),
        ),
      }),
    );
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('no mountable file systems');
  });

  test('a DMG with no .app inside becomes an error verdict', async () => {
    const v = await smokePackagedDmg(
      '/tmp/empty.dmg',
      deps({
        mount: mountThrows(
          new DmgMountError('No .app bundle found in mounted DMG', MOUNT_ERROR_CODES.noAppBundle),
        ),
      }),
    );
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('No .app bundle');
  });

  test('a wholly-skipped run against a broken DMG is an error', async () => {
    const v = await smokePackagedDmg(
      '/tmp/broken.dmg',
      deps({
        run: async () => ({ exitCode: 0 }),
        read: async () => report({ expected: 0, unexpected: 0, flaky: 0, skipped: 16 }),
      }),
    );
    expect(v.verdict).toBe(VERDICT.error);
  });

  test('a missing report is an error', async () => {
    const v = await smokePackagedDmg('/tmp/OpenKnowledge.dmg', deps({ read: async () => null }));
    expect(v.verdict).toBe(VERDICT.error);
  });
});

describe('runDriver', () => {
  function driverDeps(over) {
    const lines = [];
    const outputs = [];
    return {
      lines,
      outputs,
      deps: {
        ...deps(over ?? {}),
        log: (s) => lines.push(s),
        errStream: (s) => lines.push(s),
        env: { GITHUB_OUTPUT: '/tmp/out.txt' },
        appendFileSync: (_p, s) => outputs.push(s),
      },
    };
  }

  test('exits 0 and annotates on pass', async () => {
    const { lines, outputs, deps: d } = driverDeps();
    const code = await runDriver(['node', 'x', '/tmp/OpenKnowledge.dmg'], d);
    expect(code).toBe(0);
    expect(lines[0]).toContain('::notice::');
    expect(outputs[0]).toContain('verdict=pass');
  });

  test('exits non-zero on fail so a step that forgets to branch still fails closed', async () => {
    const { outputs, deps: d } = driverDeps({
      run: async () => ({ exitCode: 1 }),
      read: async () => report({ expected: 14, unexpected: 2, flaky: 0, skipped: 0 }),
    });
    const code = await runDriver(['node', 'x', '/tmp/OpenKnowledge.dmg'], d);
    expect(code).not.toBe(0);
    expect(code).toBe(EXIT_CODES[VERDICT.fail]);
    expect(outputs[0]).toContain('verdict=fail');
  });

  test('exits non-zero on error, with a code distinct from fail', async () => {
    const { deps: d } = driverDeps({ read: async () => null });
    const code = await runDriver(['node', 'x', '/tmp/OpenKnowledge.dmg'], d);
    expect(code).toBe(EXIT_CODES[VERDICT.error]);
    expect(EXIT_CODES[VERDICT.error]).not.toBe(EXIT_CODES[VERDICT.fail]);
  });

  test('a missing argument is an error, not a silent pass', async () => {
    const { deps: d } = driverDeps();
    expect(await runDriver(['node', 'x'], d)).toBe(EXIT_CODES[VERDICT.error]);
  });
});

describe('defensive defaults are pinned, not incidental', () => {
  // These `?? 0` fallbacks read as dead code to anyone tidying up. They are
  // the difference between "Playwright renamed a field" surfacing as an error
  // verdict and surfacing as a silent pass.
  test('a report with no stats key is an error, not a pass', () => {
    expect(classifyRun({ runExitCode: 0, report: {} }).verdict).toBe(VERDICT.error);
  });

  test('a report with an empty stats object is an error, not a pass', () => {
    expect(classifyRun({ runExitCode: 0, report: { stats: {} } }).verdict).toBe(VERDICT.error);
  });

  test('a partial stats object still counts what is there', () => {
    expect(classifyRun({ runExitCode: 0, report: { stats: { expected: 3 } } }).verdict).toBe(
      VERDICT.pass,
    );
    expect(classifyRun({ runExitCode: 1, report: { stats: { unexpected: 1 } } }).verdict).toBe(
      VERDICT.fail,
    );
  });
});
