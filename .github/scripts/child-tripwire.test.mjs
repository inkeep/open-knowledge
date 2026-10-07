import { execFileSync as unboundedExecFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  CHILD_TRIPWIRE_CODE,
  CHILD_TRIPWIRE_OPEN_CODE,
  createChildTripwire,
  STRUCTURAL_FOLLOW_UP,
} from './child-tripwire.test-helper.mjs';

const HELPER_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'child-tripwire.test-helper.mjs'),
).href;
const BOUND_MS = 2_000;
const SCENARIO_GUARD_MS = 25_000;
const OWNER_ENV = 'CHILD_TRIPWIRE_TEST_OWNER_PID';
const WHILE_THE_TEST_LIVES = `while kill -0 "$${OWNER_ENV}" 2>/dev/null; do sleep 0.2; done`;

const IGNORES_TERM = ['bash', ['-c', `trap '' TERM; echo ready; ${WHILE_THE_TEST_LIVES}`]];
const WAITS_ON_A_DESCENDANT_HOLDING_ITS_PIPE = [
  'bash',
  ['-c', `(echo ready; ${WHILE_THE_TEST_LIVES}); echo unreachable`],
];
const EXITS_WHILE_A_DESCENDANT_HOLDS_ITS_PIPE = [
  'bash',
  ['-c', `(${WHILE_THE_TEST_LIVES}) & echo ready; exit 0`],
];
const QUICK = [process.execPath, ['-e', '']];

function throughOneTripwire(calls) {
  const script =
    `import { createChildTripwire } from ${JSON.stringify(HELPER_URL)};\n` +
    `const execFileSync = createChildTripwire({ boundMs: ${BOUND_MS} });\n` +
    'const outcomes = [];\n' +
    `for (const [file, args] of ${JSON.stringify(calls)}) {\n` +
    '  const started = performance.now();\n' +
    '  try {\n' +
    "    const stdout = execFileSync(file, args, { encoding: 'utf8' });\n" +
    '    outcomes.push({ ms: performance.now() - started, returned: { stdout } });\n' +
    '  } catch (error) {\n' +
    '    outcomes.push({ ms: performance.now() - started, thrown: { code: error.code, ' +
    "message: error.message, numericStatus: typeof error.status === 'number' } });\n" +
    '  }\n' +
    '}\n' +
    'process.stdout.write(JSON.stringify(outcomes));\n';
  const scenario = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, [OWNER_ENV]: String(process.pid) },
    timeout: SCENARIO_GUARD_MS,
    killSignal: 'SIGKILL',
  });
  expect(
    scenario.error,
    `the scenario was still running ${SCENARIO_GUARD_MS} ms in, so a ${BOUND_MS} ms tripwire left ` +
      'its caller waiting on a blocked child, which is the hang the tripwire exists to end: ' +
      `stderr=${scenario.stderr}`,
  ).toBeUndefined();
  expect(scenario.status, `the scenario process failed before reporting: ${scenario.stderr}`).toBe(
    0,
  );
  return JSON.parse(scenario.stdout);
}

function expectTripped(outcome, why) {
  expect(outcome.thrown?.code, `${why}: ${JSON.stringify(outcome)}`).toBe(CHILD_TRIPWIRE_CODE);
  expect(
    outcome.thrown.message,
    'the child never reported ready before the bound fired, so this row did not drive the shape it ' +
      'names, and the diagnosis also has to carry what the child printed',
  ).toContain('stdout="ready');
  expect(
    outcome.thrown.message,
    'an interim bound has to name its structural follow-up wherever it fires',
  ).toContain(STRUCTURAL_FOLLOW_UP);
  expect(
    outcome.thrown.numericStatus,
    'a caller that keeps any execFileSync error carrying a numeric status as a verdict would read ' +
      'the diagnosis as an exit code',
  ).toBe(false);
}

describe('a child that blocks fails its test at the bound instead of holding the tier', () => {
  test('a child that ignores SIGTERM fails its caller at the bound, not when it chooses to exit', () => {
    const [outcome] = throughOneTripwire([IGNORES_TERM]);
    expectTripped(
      outcome,
      'execFileSync waits for its child to exit after the kill, so a SIGTERM the child ignores leaves ' +
        'the caller waiting as long as the child chooses, and only SIGKILL ends it at the bound',
    );
    expect(outcome.thrown.message).toContain('signal=SIGKILL');
  });

  test('a child waiting on a descendant that holds its stdout fails its caller at the bound', () => {
    const [outcome] = throughOneTripwire([WAITS_ON_A_DESCENDANT_HOLDING_ITS_PIPE]);
    expectTripped(
      outcome,
      'a child blocked on its own descendant is the shape of the bash here-document deadlock, and the ' +
        'descendant outlives the killed child while it holds the pipe the caller reads',
    );
    expect(outcome.thrown.message).toMatch(/It was killed \(pid \d+, signal=SIGKILL\)/);
  });

  test('a child that exits while a descendant holds its stdout is not reported as its exit status', () => {
    const [outcome] = throughOneTripwire([EXITS_WHILE_A_DESCENDANT_HOLDS_ITS_PIPE]);
    expectTripped(
      outcome,
      'execFileSync throws ETIMEDOUT with status 0 here, so a caller keeping errors that carry a ' +
        'status takes a cut-off capture as the verdict of a clean run',
    );
    expect(outcome.thrown.message).toMatch(
      /exited with status 0, but a descendant kept its stdout or stderr\s+open/,
    );
  });

  test('after one child trips the bound, that tripwire starts no further child', () => {
    const [first, next] = throughOneTripwire([IGNORES_TERM, QUICK]);
    expectTripped(
      first,
      'the first child has to trip the bound for this row to say anything about the next',
    );
    expect(
      next.thrown?.code,
      'a host that blocked one child is likely to block the next, and every further child costs ' +
        `another bound: ${JSON.stringify(next)}`,
    ).toBe(CHILD_TRIPWIRE_OPEN_CODE);
    expect(next.ms, 'the refusal waited for a bound instead of refusing at once').toBeLessThan(
      BOUND_MS,
    );
    expect(next.thrown.message, 'the refusal has to name the earlier child it acts on').toContain(
      `\`${IGNORES_TERM[0]} ${IGNORES_TERM[1].join(' ')}\` (pid `,
    );
    expect(
      createChildTripwire()(...QUICK, { encoding: 'utf8' }),
      'a separate tripwire does not inherit a refusal it never tripped',
    ).toBe('');
  });
});

describe('a child that finishes is unaffected by the tripwire', () => {
  const outcomeOf = (run) => {
    try {
      return { returned: run() };
    } catch (error) {
      return {
        thrown: {
          code: error.code,
          status: error.status,
          stdout: error.stdout,
          stderr: error.stderr,
        },
      };
    }
  };

  test('each child that finishes returns or throws exactly what node:child_process gives', () => {
    const execFileSync = createChildTripwire();
    const cases = [
      ['bash', ['-c', 'printf out; printf err >&2; exit 0']],
      ['bash', ['-c', 'printf out; printf err >&2; exit 7']],
      ['definitely-not-an-installed-command-7f3a', []],
    ];
    for (const [file, args] of cases) {
      const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
      expect(
        outcomeOf(() => execFileSync(file, args, options)),
        `the tripwire changed the outcome of \`${file} ${args.join(' ')}\` although it finished`,
      ).toEqual(outcomeOf(() => unboundedExecFileSync(file, args, options)));
    }
  });

  test('a caller cannot hand the tripwire its own timeout or kill signal', () => {
    const execFileSync = createChildTripwire();
    for (const options of [{ timeout: 1 }, { killSignal: 'SIGTERM' }]) {
      expect(
        () => execFileSync(...QUICK, options),
        `a caller's ${JSON.stringify(options)} would otherwise be overwritten without notice`,
      ).toThrow(/owns the timeout and the kill signal/);
    }
  });
});
