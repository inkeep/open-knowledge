import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { compileFunction, runInNewContext } from 'node:vm';
import { expect as playwrightExpect } from '@playwright/test';
import { afterEach, expect, test, vi } from 'vitest';
import type * as TypeScript from '../../../../../node_modules/typescript';
import * as settledReading from './settled-reading';

const ts: typeof TypeScript = createRequire(
  fileURLToPath(new URL('../../../../../package.json', import.meta.url)),
)('typescript');

type Size = { width: number; height: number };
type Page = { evaluate(callback: () => number): Promise<number> };
type App = {
  browserWindow(page: Page): Promise<{
    evaluate(callback: (handle: unknown, size: Size) => void, size: Size): Promise<void>;
  }>;
};
type SetWindowSize = (app: App, page: Page, width: number, height: number) => Promise<void>;

function currentSetWindowSize(): SetWindowSize {
  const path = fileURLToPath(new URL('../terminal-process-restart.e2e.ts', import.meta.url));
  const source = readFileSync(path, 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'setWindowSize',
  );
  if (!declaration) throw new Error('setWindowSize is unavailable for the smoke contract');
  const executable = ts.transpileModule(`return (${declaration.getText(parsed)});`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const bindings = { ...settledReading, expect: playwrightExpect };
  return compileFunction(executable, Object.keys(bindings), { filename: path })(
    ...Object.values(bindings),
  ) as SetWindowSize;
}

const requestedWidth = 1900;
const requestedHeight = 900;

function runCurrentWindowSize(readWidth: () => Promise<number>) {
  const setWindowSize = currentSetWindowSize();
  const readStarted = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const page: Page = {
    async evaluate(callback) {
      readStarted.resolve();
      await reading.promise;
      const innerWidth = await readWidth();
      return runInNewContext(`(${callback.toString()})()`, { window: { innerWidth } }) as number;
    },
  };
  const app: App = {
    async browserWindow(receivedPage) {
      if (receivedPage !== page) throw new Error('window lookup used another page');
      return {
        async evaluate(callback, size) {
          callback({ setSize: () => undefined }, size);
        },
      };
    },
  };
  const result = setWindowSize(app, page, requestedWidth, requestedHeight).then(
    () => 'settled',
    (error: unknown) => error,
  );
  return { result, readStarted: readStarted.promise, releaseRead: reading.resolve };
}

afterEach(() => vi.useRealTimers());

test('a requested editor width settles when the renderer read completes within the layout budget', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { result, readStarted, releaseRead } = runCurrentWindowSize(() =>
    Promise.resolve(requestedWidth),
  );
  await readStarted;
  await vi.advanceTimersByTimeAsync(settledReading.RAIL_LAYOUT_SETTLE_TIMEOUT_MS - 1);
  releaseRead();

  expect(await result).toBe('settled');
});

test('the editor width at the requested minimum is accepted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { result, readStarted, releaseRead } = runCurrentWindowSize(() =>
    Promise.resolve(requestedWidth - 100),
  );
  releaseRead();
  await readStarted;
  await vi.advanceTimersByTimeAsync(settledReading.RAIL_LAYOUT_SETTLE_TIMEOUT_MS + 1);

  expect(await result).toBe('settled');
});

test('an editor width below the requested minimum is rejected', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const belowMinimumWidth = requestedWidth - 100 - 1;
  const { result, readStarted, releaseRead } = runCurrentWindowSize(() =>
    Promise.resolve(belowMinimumWidth),
  );
  releaseRead();
  await readStarted;
  await vi.advanceTimersByTimeAsync(settledReading.RAIL_LAYOUT_SETTLE_TIMEOUT_MS + 1);

  const outcome = await result;
  expect(outcome).toBeInstanceOf(Error);
  const message = stripVTControlCharacters((outcome as Error).message);
  expect(message).toContain('expect(received).toBeGreaterThanOrEqual(expected)');
  expect(message).toMatch(new RegExp(`^Received:\\s+${belowMinimumWidth}$`, 'm'));
});

test('a rejected renderer reading remains a failure when a later reading could succeed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const failure = new Error('renderer reading failed');
  let failed = false;
  const { result, readStarted, releaseRead } = runCurrentWindowSize(() => {
    if (!failed) {
      failed = true;
      return Promise.reject(failure);
    }
    return Promise.resolve(requestedWidth);
  });
  releaseRead();
  await readStarted;
  await vi.runAllTimersAsync();

  expect(await result).toMatchObject({ message: expect.stringContaining(failure.message) });
});
