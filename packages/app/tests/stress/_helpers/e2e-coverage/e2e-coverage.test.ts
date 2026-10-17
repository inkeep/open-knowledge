import { describe, expect, test } from 'vitest';
import {
  browserCoverageFiles,
  COVERAGE_RECORD_SCHEMA,
  coverageRecordLine,
  specPath,
} from './e2e-coverage.ts';

const OK_ROOT = '/work/My Repo/public/open-knowledge';
const APP_DIR = `${OK_ROOT}/packages/app`;
const ran = (url: string, count = 1) => ({
  url,
  functions: [
    { functionName: '', ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
    { functionName: 'f', ranges: [{ startOffset: 10, endOffset: 20, count }] },
  ],
});

describe('browser coverage to recorded files', () => {
  test('scripts whose functions ran map to their source files, once each, sorted', () => {
    expect(
      browserCoverageFiles(
        [
          ran('http://127.0.0.1:4100/src/main.tsx?t=1'),
          ran('http://127.0.0.1:4100/src/main.tsx?t=2'),
          ran(
            'http://127.0.0.1:4100/@fs/work/My%20Repo/public/open-knowledge/packages/core/src/index.ts',
          ),
          ran('http://127.0.0.1:4100/src/editor/Idle.tsx', 0),
          ran('http://127.0.0.1:4100/node_modules/.vite/deps/react.js'),
          ran('http://127.0.0.1:4100/@fs/tmp/ok-w0-vite/deps/yjs.js'),
        ],
        APP_DIR,
        OK_ROOT,
      ),
    ).toEqual(['packages/app/src/main.tsx', 'packages/core/src/index.ts']);
  });
});

describe('coverage records', () => {
  test('a spec is named by its path under the Open Knowledge root', () => {
    expect(specPath(`${APP_DIR}/tests/stress/docs-open.e2e.ts`, OK_ROOT)).toBe(
      'packages/app/tests/stress/docs-open.e2e.ts',
    );
  });

  test('a record is one JSON line', () => {
    const line = coverageRecordLine({
      schema: COVERAGE_RECORD_SCHEMA,
      spec: 'packages/app/tests/stress/docs-open.e2e.ts',
      title: 'opens > a doc',
      retry: 0,
      status: 'passed',
      browser: ['packages/app/src/main.tsx'],
      server: null,
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toMatchObject({ schema: 'ok-e2e-coverage-record/1', server: null });
  });
});
