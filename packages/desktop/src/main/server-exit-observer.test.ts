import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { attachServerExitObserver, createServerExitObserver } from './server-exit-observer.ts';
import type { ServerExitInfo } from './server-exit-record.ts';

const LOCK_DIR = '/tmp/ok-project/.ok/local';
const PID = 51502;

function makeObserver(pid: number | undefined) {
  const recorded: ServerExitInfo[] = [];
  const logged: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  const observer = createServerExitObserver({
    lockDir: LOCK_DIR,
    readPid: () => pid,
    recordExit: (info) => recorded.push(info),
    logger: {
      info: (payload: Record<string, unknown>, msg: string) => logged.push({ payload, msg }),
    },
  });
  return { observer, recorded, logged };
}

describe('createServerExitObserver', () => {
  test.each([
    ['a clean exit', 0, null],
    ['a non-zero exit', 1, null],
    ['a signal kill', null, 'SIGKILL'],
    ['a signalled managed stop', null, 'SIGTERM'],
  ] as const)('%s records its code and signal verbatim', (_name, code, signal) => {
    const { observer, recorded } = makeObserver(PID);

    observer(code, signal);

    expect(recorded).toEqual([
      { lockDir: LOCK_DIR, pid: PID, code, signal, observer: 'detached-spawn' },
    ]);
  });

  test('an unavailable pid records null rather than skipping the record', () => {
    const { observer, recorded } = makeObserver(undefined);

    expect(() => observer(null, 'SIGKILL')).not.toThrow();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.pid).toBeNull();
  });

  test('each exit emits exactly one info line naming the project, pid, code and signal', () => {
    const { observer, logged } = makeObserver(PID);

    observer(null, 'SIGTERM');

    expect(logged).toHaveLength(1);
    expect(logged[0]?.payload).toMatchObject({
      event: 'server-exit.detached-child-exited',
      lockDir: LOCK_DIR,
      pid: PID,
      code: null,
      signal: 'SIGTERM',
    });
  });

  test('the log line lands even when recording the exit fails', () => {
    const logged: Array<{ payload: Record<string, unknown>; msg: string }> = [];
    const observer = createServerExitObserver({
      lockDir: LOCK_DIR,
      readPid: () => PID,
      recordExit: () => {
        throw new Error('state dir unwritable');
      },
      logger: {
        info: (payload: Record<string, unknown>, msg: string) => logged.push({ payload, msg }),
      },
    });

    expect(() => observer(null, 'SIGKILL')).not.toThrow();

    expect(logged).toHaveLength(1);
  });

  test('a throwing logger does not take the process down with it', () => {
    const recorded: ServerExitInfo[] = [];
    const observer = createServerExitObserver({
      lockDir: LOCK_DIR,
      readPid: () => PID,
      recordExit: (info) => recorded.push(info),
      logger: {
        info: () => {
          throw Object.assign(new Error("EACCES: permission denied, mkdir '/x/.ok/logs'"), {
            code: 'EACCES',
          });
        },
      },
    });

    expect(() => observer(null, 'SIGKILL')).not.toThrow();
    expect(recorded).toHaveLength(1);
  });
});

describe('attachServerExitObserver', () => {
  class FakeChild extends EventEmitter {
    constructor(public pid: number | undefined) {
      super();
    }
  }

  test('one registration turns one exit into exactly one record and one log line', () => {
    const child = new FakeChild(PID);
    const recorded: ServerExitInfo[] = [];
    const logged: Array<Record<string, unknown>> = [];

    attachServerExitObserver(child, {
      lockDir: LOCK_DIR,
      recordExit: (info) => recorded.push(info),
      logger: { info: (payload) => logged.push(payload) },
    });

    child.emit('exit', null, 'SIGKILL');

    expect(recorded).toEqual([
      { lockDir: LOCK_DIR, pid: PID, code: null, signal: 'SIGKILL', observer: 'detached-spawn' },
    ]);
    expect(logged).toHaveLength(1);
  });

  test('the pid is read through the child at exit time, not captured at registration', () => {
    const child = new FakeChild(undefined);
    const recorded: ServerExitInfo[] = [];

    attachServerExitObserver(child, {
      lockDir: LOCK_DIR,
      recordExit: (info) => recorded.push(info),
      logger: { info: () => {} },
    });
    child.pid = PID;

    child.emit('exit', 0, null);

    expect(recorded[0]?.pid).toBe(PID);
  });
});
