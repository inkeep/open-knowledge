import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  delivered,
  type ForkedWatcherProcess,
  forkWatcherProcess,
  type MutationTiming,
  type ReadinessScenario,
  reportOf,
} from './forked-watcher-process.test-helper.ts';

interface ReadinessCase {
  scenario: ReadinessScenario;
  change: string;
  initialContent: string | null;
  content: string;
}

type ManagedTiming = Exclude<MutationTiming, 'while-first-baseline-stat-held'>;

const CASES: ReadinessCase[] = [
  { scenario: 'create', change: 'creation', initialContent: null, content: 'v1' },
  { scenario: 'edit', change: 'edit', initialContent: 'v1', content: 'v2' },
];

const START_WAIT: Record<ManagedTiming, string> = {
  'as-start-resolves':
    'startManagedArtifactWatcher to resolve so the harness can change SKILL.md. The harness holds ' +
    'its first baseline sample of the held path until start waits on it, and a first sample ' +
    'fs.watchFile takes of that path until the change, so this deadlocks, by design, a watcher ' +
    'that registers fs.watchFile on the path and then awaits threadpool work before resolving',
  'after-first-baseline-stat': 'startManagedArtifactWatcher to resolve',
};

describe.skipIf(process.platform === 'win32')(
  'startManagedArtifactWatcher readiness: a SKILL.md change made after start resolves reaches onChange',
  () => {
    let root: string;
    let harness: ForkedWatcherProcess | undefined;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'ok-ma-readiness-'));
      execFileSync('mkfifo', [join(root, 'threadpool-barrier')]);
    });
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
      rmSync(root, { recursive: true, force: true });
    });

    async function changeAfterStart(
      { scenario, initialContent, content }: ReadinessCase,
      timing: ManagedTiming,
    ) {
      const skillsRoot = resolve(root, '.ok', 'skills');
      const leaf = resolve(skillsRoot, 'demo', 'SKILL.md');
      if (initialContent !== null) {
        mkdirSync(dirname(leaf), { recursive: true });
        writeFileSync(leaf, initialContent, 'utf-8');
      }
      const run = forkWatcherProcess({
        mode: 'readiness',
        entry: 'managed',
        watch: [skillsRoot],
        scenario,
        timing,
        target: leaf,
        held: scenario === 'create' ? skillsRoot : leaf,
        content,
        barrier: join(root, 'threadpool-barrier'),
      });
      harness = run;
      await run.until(START_WAIT[timing], (reports) => reportOf(reports, 'started') !== undefined);
      await run.until(
        'the harness to change SKILL.md once startManagedArtifactWatcher resolved',
        (reports) => reportOf(reports, 'mutated') !== undefined,
      );
      return {
        run,
        leaf,
        started: reportOf(run.reports(), 'started'),
        mutated: reportOf(run.reports(), 'mutated'),
      };
    }

    test.each(CASES)(
      'resolves start only once its first baseline sample has landed, and reports a SKILL.md $change made the moment start resolves',
      async (readinessCase) => {
        const { run, leaf, started } = await changeAfterStart(readinessCase, 'as-start-resolves');
        expect(
          started?.barrierEngaged,
          "the watcher's start took no sample of the held path for the harness to hold",
        ).toBe(true);
        expect(
          started?.firstBaselineStatHeldAtResolve,
          'start resolved before its first baseline sample landed, so a SKILL.md change made then becomes part of the baseline and is never reported',
        ).toBe(false);

        await run.until(
          `onChange to report the SKILL.md ${readinessCase.change} made the moment start resolved`,
          (reports) => delivered(reports, leaf, readinessCase.content),
        );
      },
    );

    test.each(CASES)(
      'reports a SKILL.md $change made once the first baseline stat has run (ordering control)',
      async (readinessCase) => {
        const { run, leaf, started, mutated } = await changeAfterStart(
          readinessCase,
          'after-first-baseline-stat',
        );
        expect(
          started?.barrierEngaged,
          "the watcher's start took no sample of the held path for the harness to hold",
        ).toBe(true);
        expect(
          mutated?.firstBaselineStatHeldAtMutation,
          'the control changes SKILL.md only after the held first baseline stat has run',
        ).toBe(false);

        await run.until(
          `onChange to report the SKILL.md ${readinessCase.change} made after the first baseline stat`,
          (reports) => delivered(reports, leaf, readinessCase.content),
        );
      },
    );
  },
);
