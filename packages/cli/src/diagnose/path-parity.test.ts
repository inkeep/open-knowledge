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
