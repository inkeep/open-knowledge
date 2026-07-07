/**
 * Cross-package path-helper equivalence guard.
 *
 * `bundle.ts` inlines path constants for `<contentDir>/.ok/local/telemetry/*`
 * and `<contentDir>/.ok/local/logs/*` rather than importing them from
 * `@inkeep/open-knowledge-server` — the on-disk layout is a stable
 * contract and the CLI should not reach into server internals for runtime
 * code (see the block comment near `bundle.ts`'s path-helper region). The
 * trade-off: if a filename or subdirectory changes in `telemetry-file-sink.ts`,
 * `bundle.ts`'s inlined copies silently desync and bundles stop finding the
 * files. This test guards against that by computing both sets of paths and
 * asserting equivalence — when they drift, this test fails.
 */

import { describe, expect, test } from 'bun:test';
import {
  logsCurrentPath as serverLogsCurrentPath,
  logsPreviousPath as serverLogsPreviousPath,
  spansCurrentPath as serverSpansCurrentPath,
  spansPreviousPath as serverSpansPreviousPath,
} from '@inkeep/open-knowledge-server';
import { _pathHelpersForTests } from './bundle.ts';

describe('CLI bundle path helpers — parity with server telemetry-file-sink', () => {
  const fixtures = ['/tmp/content', '/Users/dev/projects/foo', '/var/data/with spaces/dir'];

  for (const contentDir of fixtures) {
    test(`spansCurrentPath(${contentDir}) matches server`, () => {
      expect(_pathHelpersForTests.spansCurrentPath(contentDir)).toBe(
        serverSpansCurrentPath(contentDir),
      );
    });

    test(`spansPreviousPath(${contentDir}) matches server`, () => {
      expect(_pathHelpersForTests.spansPreviousPath(contentDir)).toBe(
        serverSpansPreviousPath(contentDir),
      );
    });

    test(`logsCurrentPath(${contentDir}) matches server`, () => {
      expect(_pathHelpersForTests.logsCurrentPath(contentDir)).toBe(
        serverLogsCurrentPath(contentDir),
      );
    });

    test(`logsPreviousPath(${contentDir}) matches server`, () => {
      expect(_pathHelpersForTests.logsPreviousPath(contentDir)).toBe(
        serverLogsPreviousPath(contentDir),
      );
    });
  }
});
