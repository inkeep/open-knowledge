import { beforeAll, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import type { BrowserFixtureRun } from './browser-fixture-run';
import { NESTED_RUN_TIMEOUT_MS } from './nested-run-budget';

const OUTSIDE = 'network-outside.fixture.ts';
const LOOPBACK = 'network-loopback.fixture.ts';

let run: BrowserFixtureRun;

function outcome(fixture: string) {
  const file = run.files?.find((entry) => entry.file === fixture);
  return {
    status: file?.status,
    tests: file?.tests.map(({ status, failureMessages }) => ({
      status,
      failure: failureMessages.join('\n').split('\n')[0],
    })),
  };
}

describe('the browser tier network guard, each side a nested controlled run', () => {
  beforeAll(async () => {
    run = await commands.runBrowserFixture({ files: [OUTSIDE, LOOPBACK] });
  }, NESTED_RUN_TIMEOUT_MS);

  test('a request to a host outside loopback fails the test that made it, naming the URL, even when the test caught the error', () => {
    expect(outcome(OUTSIDE)).toEqual({
      status: 'failed',
      tests: [
        {
          status: 'failed',
          failure:
            'Error: The browser tier reaches only loopback hosts, and this test requested https://network-guard.example/data.json. Fake the dependency at its seam, or serve it from the test server.',
        },
      ],
    });
  });

  test('requests to the test server, another loopback address, a stubbed API route and a mocked module pass the guard', () => {
    expect(outcome(LOOPBACK)).toEqual({
      status: 'passed',
      tests: [{ status: 'passed', failure: '' }],
    });
  });
});
