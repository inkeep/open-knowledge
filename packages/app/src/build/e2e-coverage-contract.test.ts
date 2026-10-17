import { describe, expect, test } from 'vitest';
import {
  browserScriptFile,
  e2eCoverageDir,
  executedOffsets,
  recordableSource,
  regionAt,
  type ScriptCoverage,
  serverScriptFiles,
  sourceRegions,
} from './e2e-coverage-contract';

const OK_ROOT = '/work/My Repo/public/open-knowledge';
const APP_DIR = `${OK_ROOT}/packages/app`;

const script = (url: string, functions: Array<[string, number, number]>): ScriptCoverage => ({
  url,
  functions: functions.map(([functionName, startOffset, count]) => ({
    functionName,
    ranges: [{ startOffset, endOffset: startOffset + 10, count }],
  })),
});

describe('which functions count as executed', () => {
  test('a function that ran counts, the module body and a function that never ran do not', () => {
    expect(
      executedOffsets(
        script('u', [
          ['', 0, 1],
          ['render', 40, 3],
          ['unused', 90, 0],
          ['', 120, 2],
        ]),
      ),
    ).toEqual([40, 120]);
    expect(executedOffsets(script('u', [['', 0, 1]]))).toEqual([]);
  });
});

describe('the coverage directory switch', () => {
  test('only a non-empty directory turns recording on', () => {
    expect(e2eCoverageDir({})).toBeUndefined();
    expect(e2eCoverageDir({ OK_E2E_COVERAGE_DIR: '' })).toBeUndefined();
    expect(e2eCoverageDir({ OK_E2E_COVERAGE_DIR: '/tmp/cov' })).toBe('/tmp/cov');
  });
});

describe('which files are recorded', () => {
  test('source files under the root are recorded by their root-relative path', () => {
    expect(recordableSource(`${APP_DIR}/src/editor/Tiptap.tsx`, OK_ROOT)).toBe(
      'packages/app/src/editor/Tiptap.tsx',
    );
    expect(recordableSource(`${OK_ROOT}/packages/server/src/api-extension.ts`, OK_ROOT)).toBe(
      'packages/server/src/api-extension.ts',
    );
  });

  test('dependencies, build output, test helpers, tests and paths outside the root are not', () => {
    for (const path of [
      `${OK_ROOT}/node_modules/.pnpm/react/index.js`,
      `${APP_DIR}/node_modules/.vite/deps/react.js`,
      `${OK_ROOT}/packages/server/dist/index.mjs`,
      `${APP_DIR}/tests/stress/_helpers/fixtures.ts`,
      `${APP_DIR}/src/build/app-version.test.ts`,
      `${OK_ROOT}/test-support/vitest.base.ts`,
      '/tmp/ok-vite-cache/deps/yjs.js',
      OK_ROOT,
    ])
      expect(recordableSource(path, OK_ROOT), path).toBeUndefined();
  });
});

describe('mapping a browser script URL to a file', () => {
  test('a Vite source URL resolves against the app root, and its query is dropped', () => {
    expect(browserScriptFile('http://127.0.0.1:4100/src/main.tsx?t=171', APP_DIR)).toBe(
      `${APP_DIR}/src/main.tsx`,
    );
  });

  test('an /@fs/ URL is the absolute file, with its encoded spaces decoded', () => {
    expect(
      browserScriptFile(
        'http://127.0.0.1:4100/@fs/work/My%20Repo/public/open-knowledge/packages/core/src/index.ts?v=1',
        APP_DIR,
      ),
    ).toBe(`${OK_ROOT}/packages/core/src/index.ts`);
  });

  test('Vite internals, optimized dependencies, the page itself and non-HTTP scripts map to nothing', () => {
    for (const url of [
      'http://127.0.0.1:4100/@vite/client',
      'http://127.0.0.1:4100/@react-refresh',
      'http://127.0.0.1:4100/@id/__x00__virtual',
      'http://127.0.0.1:4100/node_modules/.vite/deps/react.js?v=1',
      'http://127.0.0.1:4100/',
      'chrome-extension://abc/script.js',
      'not a url',
      'http://127.0.0.1:4100/%E0%A4%A',
    ])
      expect(browserScriptFile(url, APP_DIR), url).toBeUndefined();
  });
});

describe('mapping a bundled server script back to its sources', () => {
  const bundle = [
    'import { x } from "y";',
    '//#region src/a.ts',
    'function a() { return 1; }',
    '//#endregion',
    '//#region src/http/b.ts',
    'function b() { return 2; }',
    '//#endregion',
    'export { a, b };',
  ].join('\n');
  const regions = sourceRegions(bundle);
  const offsetOf = (text: string) => bundle.indexOf(text);

  test('each region spans its marked source, in order', () => {
    expect(regions.map((region) => region.path)).toEqual(['src/a.ts', 'src/http/b.ts']);
    expect(regionAt(regions, offsetOf('function a'))?.path).toBe('src/a.ts');
    expect(regionAt(regions, offsetOf('function b'))?.path).toBe('src/http/b.ts');
    expect(regionAt(regions, offsetOf('import'))).toBeUndefined();
    expect(regionAt(regions, offsetOf('export'))).toBeUndefined();
  });

  test('an executed function is attributed to its region, and an unmarked script to itself', () => {
    const covered = script('file:///pkg/dist/index.mjs', [
      ['', 0, 1],
      ['b', offsetOf('function b'), 1],
      ['a', offsetOf('function a'), 0],
    ]);
    expect(serverScriptFiles(covered, '/pkg/dist/index.mjs', regions, '/pkg')).toEqual([
      '/pkg/src/http/b.ts',
    ]);
    expect(serverScriptFiles(covered, '/pkg/src/plain.mjs', [], '/pkg')).toEqual([
      '/pkg/src/plain.mjs',
    ]);
    expect(
      serverScriptFiles(script('file:///x', [['', 0, 1]]), '/pkg/dist/index.mjs', regions, '/pkg'),
    ).toEqual([]);
  });

  test('an unterminated region runs to the end of the script', () => {
    const open = sourceRegions('//#region src/tail.ts\nfunction t() {}\n');
    expect(open).toEqual([{ start: 0, end: 38, path: 'src/tail.ts' }]);
  });
});
