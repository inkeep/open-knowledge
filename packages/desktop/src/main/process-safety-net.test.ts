import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installStdioBrokenPipeGuard, isBrokenPipeError } from './process-safety-net.ts';

/**
 * Contract: a broken-pipe error on stdout/stderr must be handled at the stream
 * boundary so it never escalates to an uncaught exception. Non-broken-pipe
 * stream errors must still be surfaced (never silently masked), and the surfacing
 * sink must never crash the process.
 */

/** A stand-in for `process.stdout` / `process.stderr` — a bare Writable-ish emitter. */
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
    // A Node EventEmitter with no 'error' listener throws synchronously on
    // emit('error', ...) — the in-process analogue of the unhandled stream
    // error that becomes an uncaught exception → Electron's fatal modal.
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
    // The whole point of the guard is "no stream error escalates". A sink that
    // throws (e.g. the file logger's lazy mkdir hitting EACCES) must not defeat
    // that — otherwise the guard re-creates the exact bug it prevents.
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
    // Exactly one report, not two — re-installing must not stack listeners.
    expect(surfaced).toHaveLength(1);
  });
});
