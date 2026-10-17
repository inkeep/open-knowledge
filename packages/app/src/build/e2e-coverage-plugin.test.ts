import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connect } from 'vite';
import { afterEach, describe, expect, test } from 'vitest';
import { E2E_COVERAGE_PATH, type ScriptCoverage } from './e2e-coverage-contract';
import {
  type CoverageSession,
  coverageMiddleware,
  diskScriptSources,
  inspectorCoverage,
  processCoverageFiles,
} from './e2e-coverage-plugin';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeRoot(): { okRoot: string; bundle: string; text: string } {
  const okRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-e2e-coverage-plugin-')));
  dirs.push(okRoot);
  const pkg = join(okRoot, 'packages', 'server');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"fake-server","type":"module"}');
  const text = [
    '//#region src/a.ts',
    'export function a() { return 1; }',
    '//#endregion',
    '//#region src/b.ts',
    'export function b() { return 2; }',
    '//#endregion',
    '',
  ].join('\n');
  const bundle = join(pkg, 'dist', 'index.mjs');
  writeFileSync(bundle, text);
  return { okRoot, bundle, text };
}

function call(
  middleware: Connect.NextHandleFunction,
  method: string,
  url: string,
): Promise<{ status: number; body: unknown; passed: boolean }> {
  return new Promise((resolve) => {
    let status = 0;
    const response = {
      set statusCode(code: number) {
        status = code;
      },
      setHeader: () => response,
      end: (text: string) => resolve({ status, body: JSON.parse(text), passed: false }),
    } as unknown as ServerResponse;
    middleware({ method, url } as Connect.IncomingMessage, response, () =>
      resolve({ status, body: null, passed: true }),
    );
  });
}

describe('server coverage over a bundled dist script', () => {
  test('an executed function maps through its region to the source file, and dependencies are skipped', () => {
    const { okRoot, bundle, text } = fakeRoot();
    const scripts: ScriptCoverage[] = [
      {
        url: pathToFileURL(bundle).href,
        functions: [
          { functionName: '', ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] },
          {
            functionName: 'b',
            ranges: [{ startOffset: text.indexOf('export function b'), endOffset: 0, count: 2 }],
          },
        ],
      },
      {
        url: pathToFileURL(join(okRoot, 'node_modules', 'dep', 'index.js')).href,
        functions: [{ functionName: 'x', ranges: [{ startOffset: 5, endOffset: 9, count: 1 }] }],
      },
      { url: 'node:internal/fs', functions: [] },
    ];
    expect(processCoverageFiles(scripts, okRoot, diskScriptSources())).toEqual([
      'packages/server/src/b.ts',
    ]);
  });

  test('the in-process inspector reports a function a real module ran', async () => {
    const { okRoot, bundle } = fakeRoot();
    const session = inspectorCoverage();
    await session.takePreciseCoverage();
    const loaded = (await import(pathToFileURL(bundle).href)) as { a: () => number };
    expect(loaded.a()).toBe(1);
    expect(
      processCoverageFiles(await session.takePreciseCoverage(), okRoot, diskScriptSources()),
    ).toEqual(['packages/server/src/a.ts']);
    expect(
      processCoverageFiles(await session.takePreciseCoverage(), okRoot, diskScriptSources()),
    ).toEqual([]);
  });
});

describe('the coverage endpoint', () => {
  const session = (scripts: ScriptCoverage[]): CoverageSession & { calls: number } => {
    const fake = {
      calls: 0,
      async takePreciseCoverage() {
        fake.calls += 1;
        return scripts;
      },
    };
    return fake;
  };

  test('reset clears the counters and reports nothing; take reports what ran since', async () => {
    const { okRoot, bundle, text } = fakeRoot();
    const ran = session([
      {
        url: pathToFileURL(bundle).href,
        functions: [
          {
            functionName: 'a',
            ranges: [{ startOffset: text.indexOf('export function a'), endOffset: 0, count: 1 }],
          },
        ],
      },
    ]);
    const middleware = coverageMiddleware(okRoot, ran, diskScriptSources());
    expect(await call(middleware, 'POST', `${E2E_COVERAGE_PATH}?op=reset`)).toEqual({
      status: 200,
      body: { files: [] },
      passed: false,
    });
    expect(await call(middleware, 'POST', `${E2E_COVERAGE_PATH}?op=take`)).toEqual({
      status: 200,
      body: { files: ['packages/server/src/a.ts'] },
      passed: false,
    });
    expect(ran.calls).toBe(2);
  });

  test('other paths and methods pass through, and an unknown op is refused', async () => {
    const quiet = session([]);
    const middleware = coverageMiddleware('/nowhere', quiet, diskScriptSources());
    expect((await call(middleware, 'GET', `${E2E_COVERAGE_PATH}?op=take`)).passed).toBe(true);
    expect((await call(middleware, 'POST', '/api/config')).passed).toBe(true);
    expect(await call(middleware, 'POST', `${E2E_COVERAGE_PATH}?op=dump`)).toMatchObject({
      status: 400,
    });
    expect(quiet.calls).toBe(0);
  });

  test('a session that fails answers 500 rather than hanging the test', async () => {
    const failing: CoverageSession = {
      takePreciseCoverage: () => Promise.reject(new Error('inspector closed')),
    };
    const middleware = coverageMiddleware('/nowhere', failing, diskScriptSources());
    expect(await call(middleware, 'POST', `${E2E_COVERAGE_PATH}?op=take`)).toEqual({
      status: 500,
      body: { error: 'inspector closed' },
      passed: false,
    });
  });
});
