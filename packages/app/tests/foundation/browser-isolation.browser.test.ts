import { describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import type { BrowserFixtureFile } from './browser-fixture-run';
import { NESTED_RUN_DEADLINE_MS, NESTED_RUN_TIMEOUT_MS } from './nested-run-budget';

const REJECTED_FACTORY_ERROR =
  'vi.mock factory for /tests/foundation/fixtures/mock-subject.ts rejected';

function verdicts(files: readonly BrowserFixtureFile[] | null) {
  return files?.map(({ file, status, tests }) => ({
    file,
    status,
    tests: tests.map(({ title, status: testStatus }) => [title, testStatus]),
  }));
}

describe('the browser tier keeps one file failure inside that file', {
  timeout: NESTED_RUN_TIMEOUT_MS,
}, () => {
  test('a vi.mock factory that rejects fails only its own file, and the files after it still run', async () => {
    const run = await commands.runBrowserFixture({
      files: [
        'rejected-factory.fixture.ts',
        'rejected-import-observed.fixture.ts',
        'unrelated-neighbor.fixture.ts',
      ],
    });

    expect(verdicts(run.files)).toEqual([
      { file: 'rejected-factory.fixture.ts', status: 'failed', tests: [] },
      {
        file: 'rejected-import-observed.fixture.ts',
        status: 'passed',
        tests: [
          ['a test that expects its mocked import to reject observes the rejection', 'passed'],
        ],
      },
      {
        file: 'unrelated-neighbor.fixture.ts',
        status: 'passed',
        tests: [['an unrelated file imports the real module', 'passed']],
      },
    ]);
    expect(run.files?.[0]?.message).toContain('Failed to import test file');
    expect(`${run.stdout}${run.stderr}`).toContain(
      `Caused by: Error: ${REJECTED_FACTORY_ERROR}: [vitest] There was an error when mocking a module.`,
    );
    expect(run.exitCode).toBe(1);
  });
});

describe('the browser tier reads CI from its launch environment', {
  timeout: NESTED_RUN_TIMEOUT_MS,
}, () => {
  const SET = 'the browser graph reads CI as set, with no Node process global';
  const UNSET = 'the browser graph reads CI as unset, with no Node process global';

  test('a launch without CI reads as local', async () => {
    const run = await commands.runBrowserFixture({ files: ['ci-mode.fixture.ts'] });

    expect(verdicts(run.files)).toEqual([
      {
        file: 'ci-mode.fixture.ts',
        status: 'failed',
        tests: [
          [SET, 'failed'],
          [UNSET, 'passed'],
        ],
      },
    ]);
  });

  test('a launch with CI=true reads as CI', async () => {
    const run = await commands.runBrowserFixture({ files: ['ci-mode.fixture.ts'], ci: 'true' });

    expect(verdicts(run.files)).toEqual([
      {
        file: 'ci-mode.fixture.ts',
        status: 'failed',
        tests: [
          [SET, 'passed'],
          [UNSET, 'failed'],
        ],
      },
    ]);
  });
});

describe('each browser test file starts with clean storage', {
  timeout: NESTED_RUN_TIMEOUT_MS,
}, () => {
  const POISON = 'storage-poison.fixture.ts';
  const WITNESS = 'storage-witness.fixture.ts';
  const passing = {
    [POISON]: {
      file: POISON,
      status: 'passed',
      tests: [['a file writes web storage and leaves an IndexedDB connection open', 'passed']],
    },
    [WITNESS]: {
      file: WITNESS,
      status: 'passed',
      tests: [['a file starts with empty web storage and no IndexedDB databases', 'passed']],
    },
  };

  test('storage the first file writes is gone when the second file starts', async () => {
    const run = await commands.runBrowserFixture({ files: [POISON, WITNESS] });

    expect(verdicts(run.files)).toEqual([passing[POISON], passing[WITNESS]]);
    expect(run.exitCode).toBe(0);
  });

  test('the same two files pass in the reverse order', async () => {
    const run = await commands.runBrowserFixture({ files: [WITNESS, POISON] });

    expect(verdicts(run.files)).toEqual([passing[POISON], passing[WITNESS]]);
    expect(run.exitCode).toBe(0);
  });

  test('Vitest collects Chromium garbage after every file when launched with the documented settings', async () => {
    const run = await commands.runBrowserFixture({ files: [POISON, WITNESS], debugGc: true });

    expect(run.exitCode).toBe(0);
    expect(run.stderr.match(/Vitest triggered Chromium garbage collection/g)).toHaveLength(2);
    expect(run.stderr).not.toContain('failed to collect Chromium garbage');
  });

  test('an IndexedDB database that cannot be deleted after a test fails that test', async () => {
    const run = await commands.runBrowserFixture({ files: ['storage-blocked.fixture.ts'] });

    expect(verdicts(run.files)).toEqual([
      {
        file: 'storage-blocked.fixture.ts',
        status: 'failed',
        tests: [['a database a worker keeps open cannot be deleted after the test', 'failed']],
      },
    ]);
    expect(run.files?.[0]?.tests[0]?.failureMessages.join('\n')).toContain(
      'IndexedDB held-by-worker could not be deleted: a connection outside this test file is still open',
    );
  });
});

describe('test-side node: substitutes keep unsupported operations failing', {
  timeout: NESTED_RUN_TIMEOUT_MS,
}, () => {
  test('a file importing a node:fs export the browser tier does not provide fails at import', async () => {
    const run = await commands.runBrowserFixture({ files: ['unsupported-node-export.fixture.ts'] });

    expect(verdicts(run.files)).toEqual([
      { file: 'unsupported-node-export.fixture.ts', status: 'failed', tests: [] },
    ]);
    expect(`${run.stdout}${run.stderr}`).toContain("does not provide an export named 'watch'");
  });
});

describe('the nested fixture run', { timeout: NESTED_RUN_TIMEOUT_MS }, () => {
  test('refuses a file name that is not a fixture in the fixture directory', async () => {
    await expect(
      commands.runBrowserFixture({ files: ['../browser-isolation.browser.test.ts'] }),
    ).rejects.toThrow('runBrowserFixture takes fixture file names only');
  });

  test('refuses a deadline longer than the shared nested-run budget', async () => {
    await expect(
      commands.runBrowserFixture({
        files: ['never-settles.fixture.ts'],
        deadlineMs: NESTED_RUN_DEADLINE_MS + 1,
      }),
    ).rejects.toThrow(
      `runBrowserFixture takes a deadline of 1 to ${NESTED_RUN_DEADLINE_MS} ms, got ${NESTED_RUN_DEADLINE_MS + 1}`,
    );
  });

  test('stops a run that does not finish by its deadline and fails naming that run', async () => {
    const deadlineMs = 3_000;

    await expect(
      commands.runBrowserFixture({ files: ['never-settles.fixture.ts'], deadlineMs }),
    ).rejects.toThrow(
      `The nested browser fixture run of never-settles.fixture.ts did not finish within ${deadlineMs} ms, so it was stopped. Its last output:\n`,
    );
  });
});
