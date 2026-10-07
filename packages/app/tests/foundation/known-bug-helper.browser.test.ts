import { beforeAll, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import type { BrowserFixtureRun } from './browser-fixture-run';
import { NESTED_RUN_TIMEOUT_MS } from './nested-run-budget';

const VARIANTS = [
  'known-bug-present.fixture.ts',
  'known-bug-fixed.fixture.ts',
  'known-bug-unrelated-inside.fixture.ts',
  'known-bug-unrelated-outside.fixture.ts',
  'known-bug-ansi.fixture.ts',
] as const;

type Variant = (typeof VARIANTS)[number];

let run: BrowserFixtureRun;

function outcome(variant: Variant) {
  const file = run.files?.find((entry) => entry.file === variant);
  return {
    status: file?.status,
    tests: file?.tests.map(({ status, failureMessages }) => ({
      status,
      failure: failureMessages.join('\n'),
    })),
  };
}

describe('expectKnownBug in browser mode, each variant a nested controlled run', () => {
  beforeAll(async () => {
    run = await commands.runBrowserFixture({ files: [...VARIANTS] });
  }, NESTED_RUN_TIMEOUT_MS);

  test('a pin passes while its bug is still present', () => {
    expect(outcome('known-bug-present.fixture.ts')).toEqual({
      status: 'passed',
      tests: [{ status: 'passed', failure: '' }],
    });
  });

  test('a pin fails once its bug is fixed, saying the known bug appears fixed', () => {
    const { status, tests } = outcome('known-bug-fixed.fixture.ts');
    expect(status).toBe('failed');
    expect(tests?.map((entry) => entry.status)).toEqual(['failed']);
    expect(tests?.[0]?.failure).toContain(
      'known bug appears fixed: the correct assertion passed, so /expected 41 to be 42/ no longer describes a failure.',
    );
  });

  test('an unrelated error inside the pinned assertion fails with that error', () => {
    const { status, tests } = outcome('known-bug-unrelated-inside.fixture.ts');
    expect(status).toBe('failed');
    expect(tests?.map((entry) => entry.status)).toEqual(['failed']);
    expect(tests?.[0]?.failure).toContain('TypeError: the subject could not be read');
  });

  test('an unrelated error before the pinned assertion fails with that error', () => {
    const { status, tests } = outcome('known-bug-unrelated-outside.fixture.ts');
    expect(status).toBe('failed');
    expect(tests?.map((entry) => entry.status)).toEqual(['failed']);
    expect(tests?.[0]?.failure).toContain('RangeError: the fixture setup failed');
  });

  test('a signature matches the wrong outcome once its ANSI colour codes are stripped', () => {
    expect(outcome('known-bug-ansi.fixture.ts')).toEqual({
      status: 'passed',
      tests: [{ status: 'passed', failure: '' }],
    });
  });
});
