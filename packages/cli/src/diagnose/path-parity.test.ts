import {
  logsCurrentPath as serverLogsCurrentPath,
  logsPreviousPath as serverLogsPreviousPath,
  spansCurrentPath as serverSpansCurrentPath,
  spansPreviousPath as serverSpansPreviousPath,
} from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import {
  lossCaptureCurrentPath as serverLossCaptureCurrentPath,
  lossCapturePreviousPath as serverLossCapturePreviousPath,
} from '../../../server/src/loss-capture.ts';
import { _pathHelpersForTests } from './bundle.ts';

describe('CLI bundle path helpers — parity with the server writers', () => {
  const fixtures = ['/tmp/content', '/Users/dev/projects/foo', '/var/data/with spaces/dir'];

  const pairs = {
    spansCurrentPath: serverSpansCurrentPath,
    spansPreviousPath: serverSpansPreviousPath,
    logsCurrentPath: serverLogsCurrentPath,
    logsPreviousPath: serverLogsPreviousPath,
    lossCaptureCurrentPath: serverLossCaptureCurrentPath,
    lossCapturePreviousPath: serverLossCapturePreviousPath,
  } satisfies Record<keyof typeof _pathHelpersForTests, (contentDir: string) => string>;

  test('every exported CLI path helper is paired with a server export', () => {
    expect(Object.keys(pairs).sort()).toEqual(Object.keys(_pathHelpersForTests).sort());
  });

  for (const [name, serverFn] of Object.entries(pairs)) {
    const cliFn = _pathHelpersForTests[name as keyof typeof _pathHelpersForTests];
    for (const contentDir of fixtures) {
      test(`${name}(${contentDir}) matches server`, () => {
        expect(cliFn(contentDir)).toBe(serverFn(contentDir));
      });
    }
  }
});
