import { relative, sep } from 'node:path';
import type { TestCase, TestModule, TestSuite } from 'vitest/node';

export type VitestFileTally = {
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

export function tallyVitestRun(
  testModules: ReadonlyArray<TestModule>,
  root: string,
  started: WeakSet<TestCase>,
): VitestFileTally[] {
  return testModules.map((testModule) => {
    const tally: VitestFileTally = {
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

export function executed(file: VitestFileTally): number {
  return file.passed + file.failed;
}

export function sumAcrossFiles(
  files: ReadonlyArray<VitestFileTally>,
  count: (file: VitestFileTally) => number,
): number {
  return files.reduce((total, file) => total + count(file), 0);
}
