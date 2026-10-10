import type { Plugin } from 'vitest/config';
import type { Reporter, TestCase, TestRunEndReason, VitestPluginContext } from 'vitest/node';
import { UNCACHED_TIER_CONFIG } from './uncached-tier';
import { executed, sumAcrossFiles, tallyVitestRun, type VitestFileTally } from './vitest-run-tally';

const UNCACHED_TIER_AUTHOR_RULE =
  'A tier test must execute wherever the tier runs; if its subject is absent from the public mirror, name the file <name>.private.uncached.test.ts; never skip a test, or condition its definition or body, on a presence probe.';

type UncachedTierVerdict = { refused: boolean; message: string };

function notExecuted(file: VitestFileTally): string[] {
  return [
    ...(file.skipped > 0 ? [`${file.skipped} skipped`] : []),
    ...(file.todo > 0 ? [`${file.todo} todo`] : []),
    ...(file.unfinished > 0 ? [`${file.unfinished} unfinished`] : []),
    ...file.emptySkippedSuites.map((name) => `skipped suite "${name}" holds no test`),
  ];
}

function failureParts(file: VitestFileTally): string[] {
  return [
    ...(file.failedDuringCollection ? ['failed during collection'] : []),
    ...(file.stopped > 0 ? [`${file.stopped} stopped by a failure`] : []),
    ...file.emptyStoppedSuites.map((name) => `stopped suite "${name}" holds no test`),
  ];
}

function uncachedTierVerdict(
  files: VitestFileTally[],
  { testNamePattern, reason }: { testNamePattern?: string; reason?: TestRunEndReason } = {},
): UncachedTierVerdict {
  if (files.length === 0) {
    return {
      refused: true,
      message: `${UNCACHED_TIER_CONFIG}: the tier fails this run because it ran no test file. Run the tier whole, or narrow it with a file filter that names an existing .uncached.test file.`,
    };
  }
  const ran = sumAcrossFiles(files, executed);
  const skipped = sumAcrossFiles(files, (file) => file.skipped);
  const todo = sumAcrossFiles(files, (file) => file.todo);
  const unfinished = sumAcrossFiles(files, (file) => file.unfinished);
  const stopped = sumAcrossFiles(files, (file) => file.stopped);
  const collected = ran + skipped + todo + unfinished + stopped;
  if (reason === 'interrupted') {
    return {
      refused: true,
      message: `${UNCACHED_TIER_CONFIG}: the tier fails this run because Vitest interrupted it before it finished, and a test the interruption cancelled cannot be told from a skipped one (executed ${ran} of ${collected}; ${files.length} files).`,
    };
  }
  const offending = files.filter(
    (file) => executed(file) === 0 || notExecuted(file).length > 0 || failureParts(file).length > 0,
  );
  if (offending.length === 0) {
    return {
      refused: false,
      message: `uncached tier: every collected test executed (${ran} of ${collected}; ${sumAcrossFiles(files, (file) => file.passed)} passed, ${sumAcrossFiles(files, (file) => file.failed)} failed; ${files.length} files).`,
    };
  }
  const lines = offending.map((file) => {
    const parts = [...notExecuted(file), ...failureParts(file)];
    const head = executed(file) === 0 ? 'no test executed' : '';
    return `  ${file.path}: ${[head, ...parts].filter((part) => part !== '').join('; ')}`;
  });
  if (testNamePattern !== undefined && skipped > 0) {
    lines.push(
      `  -t "${testNamePattern}" skipped tests by name; narrow an uncached run by file instead.`,
    );
  }
  const authorAttributable = offending.some(
    (file) =>
      notExecuted(file).length > 0 ||
      (executed(file) === 0 && file.stopped === 0 && !file.failedDuringCollection),
  );
  const counts = [
    `executed ${ran} of ${collected}`,
    `${skipped} skipped, ${todo} todo, ${unfinished} unfinished`,
    ...(stopped > 0 ? [`${stopped} stopped by a failure`] : []),
    `${files.length} files`,
  ];
  return {
    refused: true,
    message: [
      `${UNCACHED_TIER_CONFIG}: the tier fails this run because not every collected test executed (${counts.join('; ')}).`,
      ...lines,
      ...(authorAttributable ? [UNCACHED_TIER_AUTHOR_RULE] : []),
    ].join('\n'),
  };
}

function floorReporter(vitest: VitestPluginContext['vitest']): Reporter {
  const started = new WeakSet<TestCase>();
  return {
    onTestCaseReady(testCase) {
      started.add(testCase);
    },
    onTestRunEnd(testModules, _unhandledErrors, reason) {
      let verdict: UncachedTierVerdict;
      try {
        const pattern = vitest.config.testNamePattern;
        verdict = uncachedTierVerdict(tallyVitestRun(testModules, vitest.config.root, started), {
          testNamePattern: pattern === undefined ? undefined : pattern.source,
          reason,
        });
      } catch (error) {
        verdict = {
          refused: true,
          message: `${UNCACHED_TIER_CONFIG}: the tier fails this run because it could not read the run's results: ${error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)}`,
        };
      }
      if (verdict.refused) {
        process.exitCode = 1;
        console.error(verdict.message);
      } else {
        console.log(verdict.message);
      }
    },
  };
}

const INSTALLED = new WeakSet<object>();

export function uncachedTierFloor(): Plugin {
  return {
    name: 'ok:uncached-tier-floor',
    configureVitest({ vitest }) {
      if (INSTALLED.has(vitest)) return;
      INSTALLED.add(vitest);
      vitest.config.reporters.push(floorReporter(vitest));
    },
  };
}
