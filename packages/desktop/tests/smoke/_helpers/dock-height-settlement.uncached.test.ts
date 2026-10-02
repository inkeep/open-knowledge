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

const heightBefore = 300;
const heightAfter = heightBefore + 160;
const reopenedHeightTolerance = 40;

function currentDockHeightWait(label: string): string {
  const path = fileURLToPath(new URL('../terminal-dock.e2e.ts', import.meta.url));
  const source = readFileSync(path, 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let dockTest: TypeScript.CallExpression | undefined;
  const visit = (node: TypeScript.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'test' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'QA-023 panel height persists across reopen'
    ) {
      dockTest = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  const callback = dockTest?.arguments[1];
  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) {
    throw new Error('dock height smoke test is unavailable');
  }
  const pollsReading = (node: TypeScript.Node): boolean =>
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pollSettledReading' &&
      ts.isObjectLiteralExpression(node.arguments[1]) &&
      node.arguments[1].properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'reading' &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === label,
      )) ||
    ts.forEachChild(node, (child) => pollsReading(child) || undefined) === true;
  const waits = callback.body.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isAwaitExpression(statement.expression) &&
      pollsReading(statement.expression),
  );
  if (waits.length !== 1) {
    throw new Error(
      `dock height smoke test has ${waits.length} settled "${label}" waits; expected exactly one`,
    );
  }
  return waits[0].getText(parsed);
}

function runCurrentDockWait(label: string, panelHeight: number, persistedHeight: number) {
  const source = currentDockHeightWait(label);
  const path = fileURLToPath(new URL('../terminal-dock.e2e.ts', import.meta.url));
  let releaseRead: (() => void) | undefined;
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const panel = {
    async evaluate(callback: (element: unknown) => number): Promise<number> {
      markReadStarted?.();
      await reading;
      return runInNewContext(`(${callback.toString()})(element)`, {
        element: { getBoundingClientRect: () => ({ height: panelHeight }) },
      }) as number;
    },
  };
  const page = {
    async evaluate(callback: () => number): Promise<number> {
      markReadStarted?.();
      await reading;
      return runInNewContext(`(${callback.toString()})()`, {
        localStorage: {
          getItem: (key: string) =>
            key === 'ok-terminal-height-v1' ? String(persistedHeight) : null,
        },
      }) as number;
    },
  };
  const bindings = {
    ...settledReading,
    expect: playwrightExpect,
    panel,
    page,
    heightBefore,
    heightAfter,
  };
  const executable = ts.transpileModule(`return async () => { ${source} }`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const runWait = compileFunction(executable, Object.keys(bindings), { filename: path })(
    ...Object.values(bindings),
  ) as () => Promise<void>;
  const result = runWait().then(
    () => 'settled',
    (error: unknown) => error,
  );
  return { result, readStarted, releaseRead };
}

afterEach(() => vi.useRealTimers());

test.each(['height', 'persisted height', 'reopened height difference'])(
  '%s settles when its dimension read completes within the layout budget',
  async (label) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { result, readStarted, releaseRead } = runCurrentDockWait(
      label,
      heightAfter,
      heightAfter,
    );
    await readStarted;
    await vi.advanceTimersByTimeAsync(settledReading.RAIL_LAYOUT_SETTLE_TIMEOUT_MS - 1);
    releaseRead?.();

    expect(await result).toBe('settled');
  },
);

test.each([
  ['height', heightBefore, heightAfter, 'toBeGreaterThan', heightBefore],
  ['persisted height', heightAfter, heightBefore, 'toBeGreaterThan', heightBefore],
  [
    'reopened height difference',
    heightAfter + reopenedHeightTolerance,
    heightAfter,
    'toBeLessThan',
    reopenedHeightTolerance,
  ],
] as const)(
  '%s rejects a completed reading exactly on its strict boundary',
  async (label, panelHeight, persistedHeight, matcher, boundary) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { result, readStarted, releaseRead } = runCurrentDockWait(
      label,
      panelHeight,
      persistedHeight,
    );
    releaseRead?.();
    await readStarted;
    await vi.advanceTimersByTimeAsync(settledReading.RAIL_LAYOUT_SETTLE_TIMEOUT_MS + 1);

    const outcome = await result;
    expect(outcome).toBeInstanceOf(Error);
    const message = stripVTControlCharacters((outcome as Error).message);
    expect(message).toContain(`expect(received).${matcher}(expected)`);
    expect(message).toMatch(new RegExp(`^Received:\\s+${boundary}$`, 'm'));
  },
);
