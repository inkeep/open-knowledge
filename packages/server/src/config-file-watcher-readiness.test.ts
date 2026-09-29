import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  delivered,
  type ForkedWatcherProcess,
  forkWatcherProcess,
  type MutationTiming,
  type ReadinessScenario,
  reportOf,
  type WatcherEntry,
} from './forked-watcher-process.test-helper.ts';

interface ConfigReadinessCase {
  watcher: string;
  entry: WatcherEntry;
  scenario: ReadinessScenario;
  change: string;
}

const CASES: ConfigReadinessCase[] = [
  { watcher: 'startConfigFileWatcher', entry: 'config', scenario: 'create', change: 'creation' },
  { watcher: 'startConfigFileWatcher', entry: 'config', scenario: 'edit', change: 'edit' },
  {
    watcher: 'startMultiPathConfigFileWatcher',
    entry: 'multi-config',
    scenario: 'create',
    change: 'creation',
  },
  {
    watcher: 'startMultiPathConfigFileWatcher',
    entry: 'multi-config',
    scenario: 'edit',
    change: 'edit',
  },
];

const INITIAL = 'theme: light\n';
const CHANGED = 'theme: dark\nfont: mono\n';

const WATCH_FILE_DEADLOCK =
  'A first sample fs.watchFile takes of the file stays held until the harness changes the file, ' +
  'so this deadlocks, by design, a watcher that registers fs.watchFile on the path and then ' +
  'awaits threadpool work before resolving';

const START_WAIT: Record<MutationTiming, string> = {
  'as-start-resolves':
    'the watcher to resolve its start. The harness holds its first baseline sample of the file ' +
    `until start waits on it. ${WATCH_FILE_DEADLOCK}`,
  'while-first-baseline-stat-held':
    'the watcher to resolve its start. The harness changes the file while start waits on its held ' +
    `first baseline sample of the file, then releases that sample. ${WATCH_FILE_DEADLOCK}`,
  'after-first-baseline-stat': 'the watcher to resolve its start',
};

describe.skipIf(process.platform === 'win32')(
  'config file watcher readiness: a change made after start is called reaches onChange, however late',
  () => {
    let root: string;
    let harness: ForkedWatcherProcess | undefined;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'ok-config-readiness-'));
      execFileSync('mkfifo', [join(root, 'threadpool-barrier')]);
    });
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
      rmSync(root, { recursive: true, force: true });
    });

    async function changeTheFile({ entry, scenario }: ConfigReadinessCase, timing: MutationTiming) {
      const project = join(root, 'project');
      const target =
        entry === 'config' ? join(project, '.ok', 'config.yml') : join(project, '.okignore');
      const watch = entry === 'config' ? [target] : [target, join(project, '.gitignore')];
      mkdirSync(dirname(target), { recursive: true });
      if (entry === 'multi-config') writeFileSync(join(project, '.gitignore'), 'dist/\n', 'utf-8');
      if (scenario === 'edit') writeFileSync(target, INITIAL, 'utf-8');
      const run = forkWatcherProcess({
        mode: 'readiness',
        entry,
        watch,
        scenario,
        timing,
        target,
        held: target,
        content: CHANGED,
        barrier: join(root, 'threadpool-barrier'),
      });
      harness = run;
      await run.until(START_WAIT[timing], (reports) => reportOf(reports, 'started') !== undefined);
      await run.until(
        timing === 'while-first-baseline-stat-held'
          ? `the harness to report the change it made to ${basename(target)} while the watcher's first baseline sample of it was held`
          : `the harness to change ${basename(target)} once every repeating timer the watcher armed ` +
              `while starting had stopped (${reportOf(run.reports(), 'started')?.startupTimers} armed). ` +
              'A watcher that polls on a repeating timer armed during start never lets this happen, ' +
              'by design: the change must land after the startup compensation such a timer provides',
        (reports) => reportOf(reports, 'mutated') !== undefined,
      );
      return {
        run,
        target,
        started: reportOf(run.reports(), 'started'),
        mutated: reportOf(run.reports(), 'mutated'),
      };
    }

    test.each(CASES)(
      "$watcher resolves start only once its first baseline sample of the file has landed, and reports the file's $change made once start resolved and its startup compensation ended",
      async (readinessCase) => {
        const { run, target, started, mutated } = await changeTheFile(
          readinessCase,
          'as-start-resolves',
        );
        expect(
          started?.barrierEngaged,
          `the watcher's start took no sample of ${basename(target)} for the harness to hold`,
        ).toBe(true);
        expect(
          started?.firstBaselineStatHeldAtResolve,
          `start resolved before its first baseline sample of ${basename(target)} landed, so a change made then becomes part of the baseline and is never reported`,
        ).toBe(false);

        await run.until(
          `onChange to report the ${readinessCase.change} of ${basename(target)} made once start resolved ` +
            `and the watcher's startup compensation ended (${mutated?.startupTimersWaitedOut} startup timer(s) waited out)`,
          (reports) => delivered(reports, target, CHANGED),
        );
      },
    );

    test.each(CASES)(
      "$watcher reports the file's $change made while start waits on its held first baseline sample of the file",
      async (readinessCase) => {
        const { run, target, started, mutated } = await changeTheFile(
          readinessCase,
          'while-first-baseline-stat-held',
        );
        expect(
          mutated?.firstBaselineStatHeldAtMutation,
          `the harness changed ${basename(target)} while the watcher's first baseline sample of it was held`,
        ).toBe(true);
        expect(
          started?.firstBaselineStatHeldAtResolve,
          `start resolved before its first baseline sample of ${basename(target)} landed`,
        ).toBe(false);

        await run.until(
          `onChange to report the ${readinessCase.change} of ${basename(target)} made after start read the file ` +
            'and before its first baseline sample of it landed',
          (reports) => delivered(reports, target, CHANGED),
        );
      },
    );

    test.each(CASES)(
      "$watcher reports the file's $change made once the first baseline stat has run and its startup compensation ended (ordering control)",
      async (readinessCase) => {
        const { run, target, started, mutated } = await changeTheFile(
          readinessCase,
          'after-first-baseline-stat',
        );
        expect(
          started?.barrierEngaged,
          `the watcher's start took no sample of ${basename(target)} for the harness to hold`,
        ).toBe(true);
        expect(
          mutated?.firstBaselineStatHeldAtMutation,
          'the control changes the file only after the held first baseline stat has run',
        ).toBe(false);

        await run.until(
          `onChange to report the ${readinessCase.change} of ${basename(target)} made after the first baseline stat`,
          (reports) => delivered(reports, target, CHANGED),
        );
      },
    );
  },
);
