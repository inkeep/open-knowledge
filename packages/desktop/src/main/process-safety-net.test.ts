import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installStdioBrokenPipeGuard, isBrokenPipeError } from './process-safety-net.ts';


function makeStdioStub() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return { stdout, stderr };
}

const noop = () => {};

function epipe(): NodeJS.ErrnoException {
  const err = new Error('write EPIPE') as NodeJS.ErrnoException;
  err.code = 'EPIPE';
  return err;
}

function errnoError(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('isBrokenPipeError', () => {
  test('classifies EPIPE as broken-pipe', () => {
    expect(isBrokenPipeError(epipe())).toBe(true);
  });

  test('classifies ERR_STREAM_DESTROYED as broken-pipe', () => {
    expect(isBrokenPipeError(errnoError('ERR_STREAM_DESTROYED', 'write after end'))).toBe(true);
  });

  test('does NOT classify a generic error as broken-pipe', () => {
    expect(isBrokenPipeError(new Error('boom'))).toBe(false);
    expect(isBrokenPipeError({ code: 'ENOENT' })).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
    expect(isBrokenPipeError(undefined)).toBe(false);
    expect(isBrokenPipeError('EPIPE')).toBe(false);
  });
});

describe('installStdioBrokenPipeGuard', () => {
  test('RED-state baseline: without the guard, an EPIPE on stdout escalates (emit throws)', () => {
    const { stdout } = makeStdioStub();
    expect(() => stdout.emit('error', epipe())).toThrow();
  });

  test('swallows EPIPE on stdout (no throw, no escalation)', () => {
    const proc = makeStdioStub();
    installStdioBrokenPipeGuard(proc, { onNonBenignError: noop });
    expect(() => proc.stdout.emit('error', epipe())).not.toThrow();
  });

  test('swallows EPIPE on stderr (no throw, no escalation)', () => {
    const proc = makeStdioStub();
    installStdioBrokenPipeGuard(proc, { onNonBenignError: noop });
    expect(() => proc.stderr.emit('error', epipe())).not.toThrow();
  });

  test('surfaces a non-broken-pipe error on stdout with stream="stdout"', () => {
    const proc = makeStdioStub();
    const surfaced: Array<{ stream: string; err: Error }> = [];
    installStdioBrokenPipeGuard(proc, {
      onNonBenignError: (stream, err) => surfaced.push({ stream, err }),
    });
    const genuine = errnoError('ENOSPC', 'disk full');
    expect(() => proc.stdout.emit('error', genuine)).not.toThrow();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.stream).toBe('stdout');
    expect(surfaced[0]?.err).toBe(genuine);
  });

  test('surfaces a non-broken-pipe error on stderr with stream="stderr"', () => {
    const proc = makeStdioStub();
    const surfaced: Array<{ stream: string; err: Error }> = [];
    installStdioBrokenPipeGuard(proc, {
      onNonBenignError: (stream, err) => surfaced.push({ stream, err }),
    });
    const genuine = errnoError('ENOSPC', 'disk full');
    expect(() => proc.stderr.emit('error', genuine)).not.toThrow();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.stream).toBe('stderr');
    expect(surfaced[0]?.err).toBe(genuine);
  });

  test('does NOT invoke onNonBenignError for a broken-pipe error', () => {
    const proc = makeStdioStub();
    const surfaced: Error[] = [];
    installStdioBrokenPipeGuard(proc, { onNonBenignError: (_stream, err) => surfaced.push(err) });
    proc.stdout.emit('error', epipe());
    expect(surfaced).toHaveLength(0);
  });

  test('a throwing onNonBenignError sink does not crash the process', () => {
    const proc = makeStdioStub();
    installStdioBrokenPipeGuard(proc, {
      onNonBenignError: () => {
        throw new Error('logger init failed');
      },
    });
    expect(() => proc.stdout.emit('error', errnoError('ENOSPC'))).not.toThrow();
    expect(() => proc.stderr.emit('error', errnoError('ENOSPC'))).not.toThrow();
  });

  test('is idempotent — a second install does not double-handle', () => {
    const proc = makeStdioStub();
    const surfaced: Error[] = [];
    installStdioBrokenPipeGuard(proc, { onNonBenignError: (_s, err) => surfaced.push(err) });
    installStdioBrokenPipeGuard(proc, { onNonBenignError: (_s, err) => surfaced.push(err) });
    proc.stdout.emit('error', errnoError('ENOSPC'));
    expect(surfaced).toHaveLength(1);
  });
});
