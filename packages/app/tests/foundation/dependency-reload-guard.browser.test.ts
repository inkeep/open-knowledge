import { describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import type { BrowserFixtureRun } from './browser-fixture-run';
import { NESTED_RUN_TIMEOUT_MS } from './nested-run-budget';

function fixtureOutcome(run: BrowserFixtureRun, file: string) {
  return {
    exitCode: run.exitCode,
    statuses: run.files?.find((entry) => entry.file === file)?.tests.map((entry) => entry.status),
    output: `${run.stdout}\n${run.stderr}`,
  };
}

describe('a dependency outside the pre-bundled list fails the browser tier instead of reloading it silently', () => {
  test(
    'a run that needs an unlisted dependency fails and names the dependency and the list to add it to',
    async () => {
      const file = 'dependency-reload-unlisted.fixture.ts';
      const outcome = fixtureOutcome(await commands.runBrowserFixture({ files: [file] }), file);

      expect(outcome.statuses).toEqual(['passed']);
      expect(outcome.output).toContain('optimized dependencies changed. reloading');
      expect(outcome.output).toContain(
        'this run needed dependencies outside it: @codemirror/legacy-modes/mode/cobol.',
      );
      expect(outcome.output).toContain('Add them to BROWSER_OPTIMIZE_DEPS_INCLUDE');
      expect(outcome.exitCode).toBe(1);
    },
    NESTED_RUN_TIMEOUT_MS,
  );

  test(
    'a run whose dependencies are all on the list passes without a reload',
    async () => {
      const file = 'dependency-reload-listed.fixture.ts';
      const outcome = fixtureOutcome(await commands.runBrowserFixture({ files: [file] }), file);

      expect(outcome.statuses).toEqual(['passed']);
      expect(outcome.output).not.toContain('optimized dependencies changed. reloading');
      expect(outcome.output).not.toContain('Add them to BROWSER_OPTIMIZE_DEPS_INCLUDE');
      expect(outcome.exitCode).toBe(0);
    },
    NESTED_RUN_TIMEOUT_MS,
  );
});
