/**
 * Exit-to-record mapping and registration for the packaged detached server.
 * Capturing stubs rather than spies, matching the sibling
 * `server-exit-record.test.ts` posture. The call counts are exact: a death must
 * produce one record and one log line, which is why the registration is
 * exercised through `attachServerExitObserver` (the function production calls)
 * on a real `EventEmitter` — a second listener added *inside that function*
 * would double both, and a mapping test alone cannot see that. A duplicated
 * call at the wiring site is out of reach here; `server-exit-wiring.test.ts`
 * counts the call sites in `index.ts` instead.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { attachServerExitObserver, createServerExitObserver } from './server-exit-observer.ts';
import type { ServerExitInfo } from './server-exit-record.ts';

const LOCK_DIR = '/tmp/ok-project/.ok/local';
const PID = 51502;

// `pid` is required rather than defaulted: passing `undefined` to a defaulted
// parameter would silently restore the default, which is the exact case the
// unavailable-pid test needs to exercise.
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

    // `observer: 'detached-spawn'` on every shape is the opt-out: no
    // `child-process-gone` reason can describe a plain spawn child, so the
    // recorder must never join one onto these records.
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
    // `event` is the string a triager greps a bundle log for, so renaming it
    // has to break something.
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

    // Contained, not propagated: this listener runs inside an `EventEmitter`
    // callback, so a throw escaping it becomes an `uncaughtException` and —
    // this main process installing no userland handler by design — Electron's
    // fatal error dialog. A diagnostic must not kill the app whose server just
    // died.
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
        // The real failure this guard is for: the desktop logger's first use
        // lazily `mkdirSync`s `~/.ok/logs`, which can throw EACCES/ENOSPC.
        info: () => {
          throw Object.assign(new Error("EACCES: permission denied, mkdir '/x/.ok/logs'"), {
            code: 'EACCES',
          });
        },
      },
    });

    expect(() => observer(null, 'SIGKILL')).not.toThrow();
    // The record still lands. The two sinks are unrelated trees — the log goes
    // to `~/.ok/logs`, the record to `<projectRoot>/.ok/local` — and the record
    // is the durable artifact, so a fault in one must not take the other with
    // it. This assertion is what stops a future refactor collapsing the two
    // guards back into one.
    expect(recorded).toHaveLength(1);
  });
});

describe('attachServerExitObserver', () => {
  /** The slice of a spawned child the observer touches, with a settable pid. */
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
    // Node resolves `subprocess.pid` at spawn and retains it past handle
    // teardown, so reading late is safe — and reading late is what lets the
    // registration sit above the spawn site's own `pid` binding, ahead of
    // `unref()`. This pins the direction: a value captured at registration
    // would still be the stale one here.
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
