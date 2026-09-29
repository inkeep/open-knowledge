import { describe, expect, test } from 'vitest';
import { classifyExit, exitFailureDetail } from './exit-diagnosis.ts';

describe('classifyExit', () => {
  test.each([
    [{ exitCode: null, signal: 'SIGKILL', tail: undefined }, 'killed'],
    [{ exitCode: null, signal: 'SIGTERM', tail: undefined }, 'stopped'],
    [{ exitCode: null, signal: 'SIGINT', tail: undefined }, 'stopped'],
    [{ exitCode: null, signal: 'SIGSEGV', tail: undefined }, 'signal'],
    [{ exitCode: 0, signal: null, tail: undefined }, 'clean'],
    [{ exitCode: null, signal: null, tail: undefined }, 'unknown'],
    [{ exitCode: 127, signal: null, tail: undefined }, 'command-not-found'],
    [{ exitCode: 126, signal: null, tail: undefined }, 'not-executable'],
    [{ exitCode: 1, signal: null, tail: 'sh: cline: command not found' }, 'command-not-found'],
    [{ exitCode: 1, signal: null, tail: 'bash: ./agent: Permission denied' }, 'not-executable'],
    [
      { exitCode: 1, signal: null, tail: "Error: Cannot find module './dist/cli.js'" },
      'missing-module',
    ],
    [
      { exitCode: 134, signal: null, tail: 'FATAL ERROR: JavaScript heap out of memory' },
      'out-of-memory',
    ],
    [{ exitCode: 1, signal: null, tail: 'npm ERR! ENOMEM' }, 'out-of-memory'],
    [{ exitCode: 7, signal: null, tail: 'something else' }, 'unknown'],
  ] as const)('%j -> %s', (exit, cause) => {
    expect(classifyExit({ ...exit })).toEqual({
      exitCode: exit.exitCode,
      signal: exit.signal,
      cause,
    });
  });

  test('a signal wins over the exit code and the stderr tail', () => {
    expect(
      classifyExit({ exitCode: 137, signal: 'SIGKILL', tail: 'sh: cline: command not found' })
        .cause,
    ).toBe('killed');
  });

  test('a clean exit is never reclassified from the stderr history', () => {
    expect(classifyExit({ exitCode: 0, signal: null, tail: 'sh: xyz: command not found' })).toEqual(
      {
        exitCode: 0,
        signal: null,
        cause: 'clean',
      },
    );
  });

  test('only the last lines of stderr are read, so an old line does not name the cause', () => {
    const old = 'sh: xyz: command not found';
    const later = Array.from({ length: 12 }, (_, i) => `progress line ${i}`).join('\n');
    expect(classifyExit({ exitCode: 1, signal: null, tail: `${old}\n${later}` }).cause).toBe(
      'unknown',
    );
    expect(classifyExit({ exitCode: 1, signal: null, tail: `${later}\n${old}` }).cause).toBe(
      'command-not-found',
    );
  });

  test('out of memory outranks a module error printed in the same window', () => {
    expect(
      classifyExit({
        exitCode: 1,
        signal: null,
        tail: "Error: Cannot find module 'x'\nFATAL ERROR: heap out of memory",
      }).cause,
    ).toBe('out-of-memory');
  });
});

describe('exitFailureDetail', () => {
  test('carries the classification as data and the stderr tail as machine detail, with no server-written prose', () => {
    expect(
      exitFailureDetail({ exitCode: 127, signal: null, tail: 'sh: cline: command not found' }),
    ).toEqual({
      reason: 'exited',
      exit: { exitCode: 127, signal: null, cause: 'command-not-found' },
      machineDetail: 'sh: cline: command not found',
    });
  });

  test('omits machine detail when the process printed nothing', () => {
    expect(exitFailureDetail({ exitCode: 3, signal: null, tail: undefined })).toEqual({
      reason: 'exited',
      exit: { exitCode: 3, signal: null, cause: 'unknown' },
      machineDetail: undefined,
    });
  });
});
