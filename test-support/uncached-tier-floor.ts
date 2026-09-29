import { relative, sep } from 'node:path';
import type { Plugin } from 'vitest/config';
import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
  TestSuite,
  VitestPluginContext,
} from 'vitest/node';
import { UNCACHED_TIER_CONFIG } from './uncached-tier';

const UNCACHED_TIER_AUTHOR_RULE =
  'A tier test must execute wherever the tier runs; if its subject is absent from the public mirror, name the file <name>.private.uncached.test.ts; never skip a test, or condition its definition or body, on a presence probe.';

type UncachedTierFileTally = {
  path: string;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  unfinished: number;
  stopped: number;
  emptySkippedSuites: string[];
  emptyStoppedSuites: string[];
  failedDuringCollection: boolean;
};

type UncachedTierVerdict = { refused: boolean; message: string };

function failedWithOwnError(entity: TestSuite | TestModule): boolean {
  return entity.state() === 'failed' && entity.errors().length > 0;
}

function stoppedByFailure(entity: TestCase | TestSuite): boolean {
  if (entity.options.mode !== 'run') return false;
  let enclosing: TestSuite | TestModule = entity.parent;
  while (!failedWithOwnError(enclosing)) {
    if (enclosing.type === 'module') return false;
    enclosing = enclosing.parent;
  }
  return true;
}

function tallyUncachedTierRun(
  testModules: ReadonlyArray<TestModule>,
  root: string,
  started: WeakSet<TestCase>,
): UncachedTierFileTally[] {
  return testModules.map((testModule) => {
    const tally: UncachedTierFileTally = {
      path: relative(root, testModule.moduleId).split(sep).join('/'),
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      unfinished: 0,
      stopped: 0,
      emptySkippedSuites: [],
      emptyStoppedSuites: [],
      failedDuringCollection: false,
    };
    for (const test of testModule.children.allTests()) {
      const { state } = test.result();
      if (state === 'passed') tally.passed += 1;
      else if (state === 'failed') tally.failed += 1;
      else if (state === 'pending') tally.unfinished += 1;
      else if (state !== 'skipped') {
        throw new Error(`test "${test.fullName}" in ${tally.path} reports an unknown state`);
      } else if (test.options.mode === 'todo') tally.todo += 1;
      else if (!started.has(test) && stoppedByFailure(test)) tally.stopped += 1;
      else tally.skipped += 1;
    }
    for (const suite of testModule.children.allSuites()) {
      if (suite.state() === 'skipped' && suite.children.allTests().next().done) {
        if (stoppedByFailure(suite)) tally.emptyStoppedSuites.push(suite.fullName);
        else tally.emptySkippedSuites.push(suite.fullName);
      }
    }
    tally.failedDuringCollection =
      failedWithOwnError(testModule) && testModule.diagnostic().collectDuration === 0;
    return tally;
  });
}

function executed(file: UncachedTierFileTally): number {
  return file.passed + file.failed;
}

function notExecuted(file: UncachedTierFileTally): string[] {
  return [
    ...(file.skipped > 0 ? [`${file.skipped} skipped`] : []),
    ...(file.todo > 0 ? [`${file.todo} todo`] : []),
    ...(file.unfinished > 0 ? [`${file.unfinished} unfinished`] : []),
    ...file.emptySkippedSuites.map((name) => `skipped suite "${name}" holds no test`),
  ];
}

function failureParts(file: UncachedTierFileTally): string[] {
  return [
    ...(file.failedDuringCollection ? ['failed during collection'] : []),
    ...(file.stopped > 0 ? [`${file.stopped} stopped by a failure`] : []),
    ...file.emptyStoppedSuites.map((name) => `stopped suite "${name}" holds no test`),
  ];
}

function sum(files: UncachedTierFileTally[], count: (file: UncachedTierFileTally) => number) {
  return files.reduce((total, file) => total + count(file), 0);
}

function uncachedTierVerdict(
  files: UncachedTierFileTally[],
  { testNamePattern, reason }: { testNamePattern?: string; reason?: TestRunEndReason } = {},
): UncachedTierVerdict {
  if (files.length === 0) {
    return {
      refused: true,
      message: `${UNCACHED_TIER_CONFIG}: the tier fails this run because it ran no test file. Run the tier whole, or narrow it with a file filter that names an existing .uncached.test file.`,
    };
  }
  const ran = sum(files, executed);
  const skipped = sum(files, (file) => file.skipped);
  const todo = sum(files, (file) => file.todo);
  const unfinished = sum(files, (file) => file.unfinished);
  const stopped = sum(files, (file) => file.stopped);
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
      message: `uncached tier: every collected test executed (${ran} of ${collected}; ${sum(files, (file) => file.passed)} passed, ${sum(files, (file) => file.failed)} failed; ${files.length} files).`,
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
        verdict = uncachedTierVerdict(
          tallyUncachedTierRun(testModules, vitest.config.root, started),
          {
            testNamePattern: pattern === undefined ? undefined : pattern.source,
            reason,
          },
        );
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
