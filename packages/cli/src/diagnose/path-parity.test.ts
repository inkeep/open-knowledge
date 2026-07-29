/**
 * Cross-package path-helper equivalence guard.
 *
 * `bundle.ts` inlines path constants for `<contentDir>/.ok/local/telemetry/*`,
 * `<contentDir>/.ok/local/logs/*`, and `<contentDir>/.ok/local/loss-capture/*`
 * rather than importing them from `@inkeep/open-knowledge-server` — the
 * on-disk layout is a stable contract and the CLI should not reach into server
 * internals for runtime code (see the block comment near `bundle.ts`'s
 * path-helper region). The trade-off: if a filename or subdirectory changes on
 * the writer side, `bundle.ts`'s inlined copies silently desync and bundles
 * stop finding the files. This test guards against that by computing both sets
 * of paths and asserting equivalence — when they drift, this test fails.
 *
 * The loss-capture layout is reached through the server module file directly
 * because the server barrel re-exports the telemetry sink but not
 * `loss-capture.ts`. That is a test-only reach, and a deliberate one: a guard
 * that skipped the pair the barrel happens to omit would leave exactly the
 * newest helpers unguarded.
 */

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

  // Every helper the CLI inlines, paired with the server export it must match.
  // Adding a helper to `_pathHelpersForTests` without a pair here fails the
  // coverage test below rather than passing silently.
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
