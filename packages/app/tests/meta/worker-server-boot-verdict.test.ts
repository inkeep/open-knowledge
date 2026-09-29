import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  JSONReport,
  JSONReportSpec,
  JSONReportSuite,
  JSONReportTest,
  JSONReportTestResult,
} from '@playwright/test/reporter';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CASES_DIR = fileURLToPath(new URL('../stress/_helpers/boot-verdict/', import.meta.url));
const VERDICT_RUN_CONFIG = join(CASES_DIR, 'verdict-run.config.ts');
const REFUSE_PID_SIGNALS = pathToFileURL(join(CASES_DIR, 'refuse-pid-signals.ts')).href;
const PLAYWRIGHT_CLI = createRequire(join(APP_ROOT, 'package.json')).resolve(
  '@playwright/test/cli',
);

const PLAYWRIGHT_RUN_LIVENESS_BOUND_MS = 60_000;
const HELD_HANDLE_GRACE_MS = 10_000;
const STDIO_CLOSE_GRACE_MS = 5_000;
const HOOK_GRACE_MS = 5_000;
const VERDICT_RUNS_HOOK_TIMEOUT_MS =
  PLAYWRIGHT_RUN_LIVENESS_BOUND_MS + HELD_HANDLE_GRACE_MS + STDIO_CLOSE_GRACE_MS + HOOK_GRACE_MS;

const BOOT_CASE = 'boot-prerequisite';
const ASSERTION_CASE = 'assertion-failure';
const CONTROL_CASE = 'passing-control';
const RECOVERED_CASE = 'recovered-setup';

interface VerdictRun {
  cases: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  heldHandleBoundFired: boolean;
  stdioClosed: boolean;
  transcript: string;
  report: JSONReport | undefined;
  bodiesRan: string[];
  bootFailureInjected: boolean;
  workersRefusingGroupSignals: string[];
  groupSignalsOtherThanProbes: RefusedSignal[];
}

interface RefusedSignal {
  caller?: number;
  worker?: string;
  pid: number;
  signal?: string | number;
}

interface DeclaredResult {
  status: JSONReportTestResult['status'];
  expectedStatus: JSONReportTest['expectedStatus'];
  outcome: JSONReportTest['status'];
  ok: boolean;
  annotationTypes: string[];
}

const runDirs: string[] = [];
const liveChildren = new Set<ChildProcess>();

function linesOf(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
}

async function runVerdictCases(cases: string[], retries: number): Promise<VerdictRun> {
  const runDir = mkdtempSync(join(tmpdir(), 'ok-boot-verdict-'));
  runDirs.push(runDir);
  const childTmp = join(runDir, 'tmp');
  mkdirSync(childTmp);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OK_BOOT_VERDICT_RUN_DIR: runDir,
    OK_BOOT_VERDICT_LIVENESS_BOUND_MS: String(PLAYWRIGHT_RUN_LIVENESS_BOUND_MS),
    NODE_OPTIONS: `--import=${REFUSE_PID_SIGNALS}`,
    TMPDIR: childTmp,
    PLAYWRIGHT_HTML_OUTPUT_DIR: join(runDir, 'html-report'),
    PLAYWRIGHT_HTML_OPEN: 'never',
  };
  delete env.CI;
  delete env.GITHUB_ACTIONS;

  const child = spawn(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '--config',
      VERDICT_RUN_CONFIG,
      '--workers=1',
      `--retries=${retries}`,
      ...cases.map((name) => `${name}.verdict-case.ts`),
    ],
    { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  liveChildren.add(child);
  let transcript = '';
  child.stdout.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });
  const closed = new Promise<true>((resolve) => {
    child.once('close', () => resolve(true));
  });
  let heldHandleBoundFired = false;
  const heldHandleBound = setTimeout(() => {
    heldHandleBoundFired = true;
    child.kill('SIGKILL');
  }, PLAYWRIGHT_RUN_LIVENESS_BOUND_MS + HELD_HANDLE_GRACE_MS);
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => resolve({ exitCode: code, signal: exitSignal }));
  }).finally(() => {
    clearTimeout(heldHandleBound);
    liveChildren.delete(child);
  });
  let stdioCloseBound: ReturnType<typeof setTimeout> | undefined;
  const stdioClosed = await Promise.race([
    closed,
    new Promise<false>((resolve) => {
      stdioCloseBound = setTimeout(() => resolve(false), STDIO_CLOSE_GRACE_MS);
    }),
  ]).finally(() => clearTimeout(stdioCloseBound));
  if (!stdioClosed) {
    child.stdout.destroy();
    child.stderr.destroy();
  }

  const reportPath = join(runDir, 'results.json');
  const workerGroupRefusals = linesOf(join(runDir, 'refused-signals.jsonl'))
    .map((line) => JSON.parse(line) as RefusedSignal)
    .filter((refusal) => refusal.pid < 0 && refusal.worker !== undefined);
  return {
    cases,
    exitCode,
    signal,
    heldHandleBoundFired,
    stdioClosed,
    transcript,
    report: existsSync(reportPath)
      ? (JSON.parse(readFileSync(reportPath, 'utf8')) as JSONReport)
      : undefined,
    bodiesRan: readdirSync(runDir)
      .filter((entry) => entry.startsWith('body-ran.'))
      .map((entry) => entry.slice('body-ran.'.length))
      .sort(),
    bootFailureInjected: existsSync(join(runDir, 'boot-failure-injected')),
    workersRefusingGroupSignals: workerGroupRefusals.flatMap((refusal) =>
      refusal.worker === undefined ? [] : [refusal.worker],
    ),
    groupSignalsOtherThanProbes: workerGroupRefusals.filter((refusal) => refusal.signal !== 0),
  };
}

function specsOf(suites: JSONReportSuite[]): JSONReportSpec[] {
  return suites.flatMap((suite) => [...suite.specs, ...specsOf(suite.suites ?? [])]);
}

function soleTestOf(
  run: VerdictRun,
  caseName: string,
): { spec: JSONReportSpec; test: JSONReportTest } {
  const specs = specsOf(run.report?.suites ?? []).filter(
    (spec) => spec.file === `${caseName}.verdict-case.ts`,
  );
  expect(specs, `${caseName} appears exactly once in the JSON report`).toHaveLength(1);
  const [spec] = specs as [JSONReportSpec];
  expect(spec.tests, `${caseName} ran in exactly one project`).toHaveLength(1);
  const [jsonTest] = spec.tests as [JSONReportTest];
  return { spec, test: jsonTest };
}

function declaredResult(run: VerdictRun, caseName: string): DeclaredResult {
  const { spec, test: jsonTest } = soleTestOf(run, caseName);
  expect(jsonTest.results, `${caseName} has exactly one attempt`).toHaveLength(1);
  const [result] = jsonTest.results as [JSONReportTestResult];
  const annotationTypes = new Set(
    [...jsonTest.annotations, ...result.annotations].map((annotation) => annotation.type),
  );
  return {
    status: result.status,
    expectedStatus: jsonTest.expectedStatus,
    outcome: jsonTest.status,
    ok: spec.ok,
    annotationTypes: [...annotationTypes].sort(),
  };
}

function declaredMarkers(result: DeclaredResult): Set<string> {
  return new Set([
    `status:${result.status}`,
    ...result.annotationTypes.map((type) => `annotation:${type}`),
  ]);
}

function requireCompletedRun(run: VerdictRun): void {
  const context = `verdict run [${run.cases.join(', ')}] transcript:\n${run.transcript}`;
  expect(run.heldHandleBoundFired, `the held-handle bound preempted the run; ${context}`).toBe(
    false,
  );
  expect(run.signal, `the run ended on a signal; ${context}`).toBeNull();
  expect(
    run.stdioClosed,
    `the run exited, but its stdout and stderr had not both closed ${STDIO_CLOSE_GRACE_MS} ms later, so this transcript may be incomplete and a process the run started may still hold one of them open; ${context}`,
  ).toBe(true);
  expect(run.report, `the run wrote no JSON report; ${context}`).toBeDefined();
  expect(
    run.report?.errors ?? [],
    `the run reported errors outside any test, such as its liveness bound; ${context}`,
  ).toEqual([]);
}

function requireRefusedDevServerReaps(run: VerdictRun): void {
  const bootAttemptWorkers = soleTestOf(run, BOOT_CASE).test.results.map((result) =>
    String(result.workerIndex),
  );
  expect(
    bootAttemptWorkers,
    `verdict run [${run.cases.join(', ')}] recorded no boot attempt`,
  ).not.toEqual([]);
  expect(
    run.workersRefusingGroupSignals,
    `verdict run [${run.cases.join(', ')}] ran its boot attempts in Playwright workers ${bootAttemptWorkers.join(', ')}, and each of them reaps its exited dev server by probing that server's process group with signal 0, never signalling it, so each must have recorded that probe as refused; a worker missing here reaped outside the refusal preload and could have signalled a real process group`,
  ).toEqual(expect.arrayContaining(bootAttemptWorkers));
  expect(
    run.groupSignalsOtherThanProbes,
    `verdict run [${run.cases.join(', ')}] reaps only dev servers whose leader has already exited, so every process-group call its workers made must be a signal-0 probe; any other signal was sent to a group whose leader teardown no longer held`,
  ).toEqual([]);
}

const REPORTER_ERROR_MARKER = 'Error in reporter';

function nonResultAnnotationType(): string {
  const boot = declaredResult(bootRun, BOOT_CASE);
  const executedTypes = new Set([
    ...declaredResult(assertionRun, ASSERTION_CASE).annotationTypes,
    ...declaredResult(bootRun, CONTROL_CASE).annotationTypes,
  ]);
  const nonResultTypes = boot.annotationTypes.filter((type) => !executedTypes.has(type));
  expect(
    nonResultTypes,
    `the boot non-result declared the annotation types ${JSON.stringify(boot.annotationTypes)}; exactly one of them must be a type no executed result declares, and that type is the tag its rendering is read under`,
  ).toHaveLength(1);
  return nonResultTypes[0] as string;
}

function declaredReasons(result: JSONReportTestResult, type: string): Array<string | undefined> {
  return result.annotations
    .filter((annotation) => annotation.type === type)
    .map((annotation) => annotation.description);
}

function linesTaggedWith(run: VerdictRun, type: string): string[] {
  return run.transcript.split(/\r?\n/).filter((line) => line.startsWith(`[${type}]`));
}

function renderedNonResultLines(type: string): string[] {
  const rendered = linesTaggedWith(bootRun, type);
  expect(
    rendered,
    `the run holding the boot non-result rendered no line tagged [${type}], so the stress config's reporters never read the declaration; transcript:\n${bootRun.transcript}`,
  ).not.toEqual([]);
  return rendered;
}

let bootRun: VerdictRun;
let assertionRun: VerdictRun;
let retriedBootRun: VerdictRun;
let recoveredRun: VerdictRun;

function settledRun(settled: PromiseSettledResult<VerdictRun>): VerdictRun {
  if (settled.status === 'rejected') throw settled.reason;
  return settled.value;
}

beforeAll(async () => {
  const [boot, assertion, retriedBoot, recovered] = await Promise.allSettled([
    runVerdictCases([BOOT_CASE, CONTROL_CASE], 0),
    runVerdictCases([ASSERTION_CASE], 0),
    runVerdictCases([BOOT_CASE], 1),
    runVerdictCases([RECOVERED_CASE], 1),
  ]);
  bootRun = settledRun(boot);
  assertionRun = settledRun(assertion);
  retriedBootRun = settledRun(retriedBoot);
  recoveredRun = settledRun(recovered);
  for (const run of [bootRun, assertionRun, retriedBootRun, recoveredRun]) {
    requireCompletedRun(run);
  }
  expect(
    bootRun.bootFailureInjected,
    `the dev-server child never reached the injected failure; transcript:\n${bootRun.transcript}`,
  ).toBe(true);
  requireRefusedDevServerReaps(bootRun);
  expect(bootRun.bodiesRan, 'only the control body ran beside the boot failure').toEqual([
    CONTROL_CASE,
  ]);
  expect(assertionRun.bodiesRan, 'the assertion-failure body ran').toEqual([ASSERTION_CASE]);
  expect(assertionRun.bootFailureInjected, 'the assertion-failure run booted no server').toBe(
    false,
  );
  expect(
    retriedBootRun.bootFailureInjected,
    `the retried dev-server child never reached the injected failure; transcript:\n${retriedBootRun.transcript}`,
  ).toBe(true);
  requireRefusedDevServerReaps(retriedBootRun);
  expect(retriedBootRun.bodiesRan, 'no attempt of the retried boot case ran its body').toEqual([]);
  expect(
    recoveredRun.bodiesRan,
    'the recovered case ran its body once its setup completed',
  ).toEqual([RECOVERED_CASE]);
}, VERDICT_RUNS_HOOK_TIMEOUT_MS);

afterAll(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const runDir of runDirs.splice(0)) rmSync(runDir, { recursive: true, force: true });
});

describe('a worker-server boot failure is declared as a non-result, not as an executed assertion failure', () => {
  test('the boot non-result carries a declared marker that neither an executed assertion failure nor a passing test carries', () => {
    const boot = declaredResult(bootRun, BOOT_CASE);
    const assertionFailure = declaredResult(assertionRun, ASSERTION_CASE);
    const control = declaredResult(bootRun, CONTROL_CASE);
    const executedMarkers = new Set([
      ...declaredMarkers(assertionFailure),
      ...declaredMarkers(control),
    ]);
    const nonResultMarkers = [...declaredMarkers(boot)].filter(
      (marker) => !executedMarkers.has(marker),
    );

    expect(
      nonResultMarkers,
      `boot declared ${JSON.stringify(boot)}; the executed assertion failure declared ${JSON.stringify(assertionFailure)}`,
    ).not.toEqual([]);
  });

  test('the boot non-result still fails closed: never passed, never skipped, and its run exits non-zero', () => {
    const boot = declaredResult(bootRun, BOOT_CASE);

    expect(boot.status).not.toBe('passed');
    expect(boot.status).not.toBe('skipped');
    expect(boot.ok).toBe(false);
    expect(declaredResult(bootRun, CONTROL_CASE).status).toBe('passed');
    expect(bootRun.exitCode).not.toBe(0);
  });

  test('a declared non-result whose retry passes leaves its run passing: the declaration replaces no run status', () => {
    const { test: recoveredTest } = soleTestOf(recoveredRun, RECOVERED_CASE);

    expect(
      recoveredTest.status,
      "the recovered case is its run's only test, and its passing retry makes that test flaky",
    ).toBe('flaky');
    expect(
      recoveredRun.exitCode,
      'the stock config sets failOnFlakyTests: false, so Playwright passes a run whose only test is flaky; a non-zero exit means a reporter replaced the run status because the run held a declared setup non-result',
    ).toBe(0);
  });

  test('an executed assertion failure keeps its declared result and acquires no marker', () => {
    expect(declaredResult(assertionRun, ASSERTION_CASE)).toEqual({
      status: 'failed',
      expectedStatus: 'passed',
      outcome: 'unexpected',
      ok: false,
      annotationTypes: [],
    });
    expect(assertionRun.exitCode).not.toBe(0);
  });

  test('a passing test beside the boot non-result keeps its declared result', () => {
    expect(declaredResult(bootRun, CONTROL_CASE)).toEqual({
      status: 'passed',
      expectedStatus: 'passed',
      outcome: 'expected',
      ok: true,
      annotationTypes: [],
    });
  });
});

describe('the stress reporters render a declared setup non-result under its declared type, and nothing else', () => {
  test('the run holding the boot non-result renders it, tagged, with its test title and declared reason, and does not render the passing test beside it', () => {
    const type = nonResultAnnotationType();
    const rendered = renderedNonResultLines(type);
    const { spec: bootSpec, test: bootTest } = soleTestOf(bootRun, BOOT_CASE);
    const { spec: controlSpec } = soleTestOf(bootRun, CONTROL_CASE);
    const reasons = bootTest.results.flatMap((result) => declaredReasons(result, type));
    expect(
      reasons,
      'the boot attempt declares its non-result once, carrying the reason its setup did not complete',
    ).toEqual([expect.stringMatching(/\S/)]);
    const reasonFirstLine = (reasons[0] as string).split('\n')[0] as string;

    expect(
      rendered.filter((line) => line.includes(bootSpec.title)),
      `no line tagged [${type}] names the boot test "${bootSpec.title}"; tagged lines:\n${rendered.join('\n')}`,
    ).not.toEqual([]);
    expect(
      rendered.filter((line) => line.includes(reasonFirstLine)),
      `no line tagged [${type}] carries the declared reason "${reasonFirstLine}"; tagged lines:\n${rendered.join('\n')}`,
    ).not.toEqual([]);
    expect(
      rendered.filter((line) => line.includes(controlSpec.title)),
      `a line tagged [${type}] names the passing test "${controlSpec.title}", which declared nothing`,
    ).toEqual([]);
  });

  test('a run whose only failure is an executed assertion failure renders no line under the non-result type', () => {
    const type = nonResultAnnotationType();
    renderedNonResultLines(type);

    expect(
      linesTaggedWith(assertionRun, type),
      `the executed assertion failure declared nothing, yet its run rendered lines tagged [${type}]; transcript:\n${assertionRun.transcript}`,
    ).toEqual([]);
  });

  test('rendering the non-result raises no reporter error in any run', () => {
    renderedNonResultLines(nonResultAnnotationType());

    for (const run of [bootRun, assertionRun, retriedBootRun, recoveredRun]) {
      expect(
        run.transcript,
        `verdict run [${run.cases.join(', ')}] reported a reporter error`,
      ).not.toContain(REPORTER_ERROR_MARKER);
    }
  });

  test('each attempt of a retried boot non-result declares its own non-result and is rendered as its own entry, the retry marked', () => {
    const type = nonResultAnnotationType();
    const { spec, test: retriedTest } = soleTestOf(retriedBootRun, BOOT_CASE);

    expect(
      retriedTest.results.map((result) => declaredReasons(result, type).length > 0),
      `each of the boot case's attempts under --retries=1 must declare [${type}] on its own result`,
    ).toEqual([true, true]);
    expect(retriedTest.status, 'every attempt failed closed, so the test is unexpected').toBe(
      'unexpected',
    );
    expect(retriedBootRun.exitCode).not.toBe(0);
    expect(
      linesTaggedWith(retriedBootRun, type).filter((line) => line.includes(spec.title)),
      `the retried run must render one tagged entry per attempt, the second marked as retry #1; transcript:\n${retriedBootRun.transcript}`,
    ).toEqual([expect.not.stringContaining('(retry #'), expect.stringContaining('(retry #1)')]);
  });

  test('a declared attempt whose retry passes is never rendered as a counted failure', () => {
    const type = nonResultAnnotationType();
    const { test: recoveredTest } = soleTestOf(recoveredRun, RECOVERED_CASE);

    expect(
      recoveredTest.results.map((result) => declaredReasons(result, type).length > 0),
      `the recovered case must declare [${type}] on its first attempt only and complete its setup on the retry`,
    ).toEqual([true, false]);
    expect(
      recoveredTest.status,
      'the passing retry makes the test flaky, which the run does not count as failed',
    ).toBe('flaky');
    const rendered = linesTaggedWith(recoveredRun, type);
    expect(
      rendered,
      `the recovered run rendered no line tagged [${type}] for its declared attempt; transcript:\n${recoveredRun.transcript}`,
    ).not.toEqual([]);
    expect(
      rendered.filter((line) => /\bfailed\b/.test(line)),
      `the recovered run holds no failed test, yet a line tagged [${type}] says failed; transcript:\n${recoveredRun.transcript}`,
    ).toEqual([]);
  });

  test('every rendered entry ends with the final outcome results.json records for its test', () => {
    const type = nonResultAnnotationType();

    for (const [run, caseName] of [
      [bootRun, BOOT_CASE],
      [retriedBootRun, BOOT_CASE],
      [recoveredRun, RECOVERED_CASE],
    ] as const) {
      const { spec, test: jsonTest } = soleTestOf(run, caseName);
      const entries = linesTaggedWith(run, type).filter((line) => line.includes(spec.title));
      expect(
        entries,
        `verdict run [${run.cases.join(', ')}] rendered no entry for "${spec.title}"; transcript:\n${run.transcript}`,
      ).not.toEqual([]);
      expect(
        entries,
        `each entry for "${spec.title}" in verdict run [${run.cases.join(', ')}] must end with "${jsonTest.status}", the outcome results.json records for that test`,
      ).toEqual(entries.map(() => expect.stringMatching(new RegExp(`\\b${jsonTest.status}$`))));
    }
  });

  test('the whole rendering is one block, so it cannot interleave with the per-test output beside it', () => {
    const type = nonResultAnnotationType();
    const lines = retriedBootRun.transcript.split(/\r?\n/);
    const tagged = lines.flatMap((line, index) => (line.startsWith(`[${type}]`) ? [index] : []));

    expect(
      tagged.length,
      `the retried run declares one non-result per attempt, so its rendering must span more than one line; transcript:\n${retriedBootRun.transcript}`,
    ).toBeGreaterThan(1);
    expect(
      lines
        .slice(tagged[0], tagged[tagged.length - 1] + 1)
        .filter((line) => !line.startsWith(`[${type}]`)),
      `every line between the first and last line tagged [${type}] must carry that tag; an untagged line among them means the rendering was emitted per test rather than once at the end, which is what lets it interleave with the terminal reporter; transcript:\n${retriedBootRun.transcript}`,
    ).toEqual([]);
  });
});
