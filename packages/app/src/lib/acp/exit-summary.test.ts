import { describe, expect, test } from 'vitest';
import { exitSummary } from './exit-summary';

describe('exitSummary', () => {
  test.each([
    [{ exitCode: null, signal: 'SIGKILL', cause: 'killed' }, 'was killed (SIGKILL)'],
    [{ exitCode: null, signal: 'SIGTERM', cause: 'stopped' }, 'told to stop (SIGTERM)'],
    [{ exitCode: null, signal: 'SIGSEGV', cause: 'signal' }, 'stopped by a SIGSEGV signal'],
    [{ exitCode: 134, signal: null, cause: 'out-of-memory' }, 'ran out of memory'],
    [{ exitCode: 127, signal: null, cause: 'command-not-found' }, 'was not found (exit code 127)'],
    [{ exitCode: 126, signal: null, cause: 'not-executable' }, 'could not be run (exit code 126)'],
    [{ exitCode: 1, signal: null, cause: 'missing-module' }, 'missing files'],
    [{ exitCode: 0, signal: null, cause: 'clean' }, 'ended on its own'],
    [{ exitCode: 7, signal: null, cause: 'unknown' }, 'stopped with exit code 7'],
    [{ exitCode: null, signal: null, cause: 'unknown' }, 'for an unknown reason'],
  ] as const)('%j reads as one plain sentence', (exit, fragment) => {
    const text = exitSummary({ ...exit });
    expect(text).toContain(fragment);
    expect(text.endsWith('.')).toBe(true);
    expect(text).not.toContain('{');
  });
});
