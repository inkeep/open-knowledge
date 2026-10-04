import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import {
  captureBoundedCliOutput,
  runWindowsGuardSlice,
} from '../support/windows-os-state-proof.test-helper.ts';

function recordingGuard(pid?: number) {
  const sends: string[] = [];
  const unrefs: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout,
    stderr,
    stdin,
    kill() {
      sends.push('owned-helper-kill');
      queueMicrotask(() => {
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      });
      return true;
    },
    unref() {
      unrefs.push('owned-helper-unref');
    },
  });
  return { child, sends, unrefs, stdout, stderr, stdin };
}

afterEach(() => vi.useRealTimers());

test('a guard stalled before ready is bounded through its original recording handle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fixture = recordingGuard(93_421);
  const running = runWindowsGuardSlice('deadline', () => fixture.child);
  await vi.advanceTimersByTimeAsync(8_000);
  const result = await running;
  expect(result).toEqual(
    expect.objectContaining({
      pid: 93_421,
      ready: false,
      reason: 'deadline',
      delivery: 'accepted',
      exitObserved: true,
      exitCode: 1,
    }),
  );
  expect(fixture.sends).toEqual(['owned-helper-kill']);
  expect(fixture.stdin.writableEnded).toBe(true);
  expect(fixture.stdout.destroyed).toBe(true);
  expect(fixture.stderr.destroyed).toBe(true);
  expect(fixture.unrefs).toEqual(['owned-helper-unref']);
});

test('an oversized ready frame requests output-limit cleanup on the owned recording helper', async () => {
  const fixture = recordingGuard(93_421);
  const running = runWindowsGuardSlice('owner-loss', () => fixture.child);
  fixture.stdout.write('X'.repeat(65));
  const result = await running;
  expect(result.ready).toBe(false);
  expect(result.reason).toBe('output-limit');
  expect(result.delivery).toBe('accepted');
  expect(result.exitObserved).toBe(true);
  expect(fixture.sends).toEqual(['owned-helper-kill']);
});

test('an observed exit before ready prevents a termination send', async () => {
  const fixture = recordingGuard(93_421);
  const running = runWindowsGuardSlice('deadline', () => fixture.child);
  fixture.child.emit('exit', 0, null);
  fixture.child.emit('close', 0, null);
  const result = await running;
  expect(result).toEqual(
    expect.objectContaining({
      ready: false,
      reason: 'owner-loss',
      delivery: 'already-exited',
      exitObserved: true,
      exitCode: 0,
    }),
  );
  expect(fixture.sends).toEqual([]);
});

test('a helper without a spawn PID has an error listener and receives no termination call', async () => {
  const fixture = recordingGuard();
  const running = runWindowsGuardSlice('deadline', () => fixture.child);
  queueMicrotask(() => {
    fixture.child.emit('error', new Error('private spawn text'));
    fixture.child.emit('close', null, null);
  });
  const result = await running;
  expect(result).toEqual(
    expect.objectContaining({
      pid: null,
      ready: false,
      reason: 'owner-loss',
      delivery: 'no-pid',
      exitObserved: true,
    }),
  );
  expect(fixture.sends).toEqual([]);
});

test('CLI capture drops excess stdout without retaining later content or signaling the process', async () => {
  const cli = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      throw new Error('CLI signal must stay recorded');
    }),
  });
  const captured = captureBoundedCliOutput(cli);
  cli.stdout.write('private output '.repeat(32 * 1024));
  cli.stdout.write('more private output');
  cli.stderr.write('private stderr');
  cli.emit('close', 0, null);
  expect(await captured).toEqual(
    expect.objectContaining({
      code: 0,
      stdout: null,
      stderrBytes: Buffer.byteLength('private stderr'),
    }),
  );
  expect(cli.kill).not.toHaveBeenCalled();
});
