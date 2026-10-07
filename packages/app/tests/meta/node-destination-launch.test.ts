import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITEST_CLI = resolve(
  dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
  'vitest.mjs',
);
const FIXTURE_CONFIG = 'tests/foundation/fixtures/vitest.node-fixture.config.ts';
const RUN_TIMEOUT_MS = 20_000;

type CliRun = { exitCode: number | string | null; killed: boolean; output: string };

type ReportedTest = { title: string; status: string; failureMessages: string[] };
type ReportedFile = { name: string; status: string; assertionResults: ReportedTest[] };

const scratch: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-node-tier-'));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runVitest(args: string[]): Promise<CliRun> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [VITEST_CLI, 'run', ...args],
      {
        cwd: APP_ROOT,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        timeout: RUN_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        resolveRun({
          exitCode: error?.code ?? 0,
          killed: error?.killed ?? false,
          output: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

describe('the Node tier invocation', () => {
  test('a Node tier invocation that selects no test file fails instead of passing', async () => {
    const run = await runVitest([
      '--config',
      'vitest.node.config.ts',
      'tests/foundation/no-such-node-test',
    ]);

    expect(run.killed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('No test files found');
    expect(run.output).not.toContain('passed');
  });

  test('a malformed Node tier config fails the invocation instead of passing', async () => {
    const config = join(scratchDir(), 'vitest.node.config.ts');
    writeFileSync(config, "export default { test: { include: ['**/*.node.test.ts'] }\n");

    const run = await runVitest(['--config', config]);

    expect(run.killed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain(`failed to load config from ${config}`);
    expect(run.output).not.toContain('Test Files');
  });

  test('a Node test that defines a DOM global fails, at module load or while it runs, and a DOM-free neighbour still passes', async () => {
    const report = join(scratchDir(), 'report.json');

    const run = await runVitest([
      '--config',
      FIXTURE_CONFIG,
      '--reporter=json',
      `--outputFile=${report}`,
    ]);

    expect(run.killed).toBe(false);
    expect(run.exitCode).toBe(1);
    const files = (JSON.parse(readFileSync(report, 'utf8')) as { testResults: ReportedFile[] })
      .testResults;
    const verdicts = Object.fromEntries(
      files.map((file) => [
        basename(file.name),
        file.assertionResults.map((result) => ({
          status: result.status,
          message: result.failureMessages.join('\n').split('\n')[0],
        })),
      ]),
    );
    expect(verdicts).toEqual({
      'dom-free.node-fixture.ts': [{ status: 'passed', message: '' }],
      'dom-defined-at-load.node-fixture.ts': [
        {
          status: 'failed',
          message:
            'Error: The Node destination runs without a DOM, but window is defined before this test runs. A test that needs a DOM belongs in the browser destination (*.browser.test.ts?(x)); otherwise remove what installs it.',
        },
      ],
      'dom-defined-in-test.node-fixture.ts': [
        {
          status: 'failed',
          message:
            'Error: The Node destination runs without a DOM, but localStorage is defined after this test ran. A test that needs a DOM belongs in the browser destination (*.browser.test.ts?(x)); otherwise remove what installs it.',
        },
      ],
    });
  });
});
