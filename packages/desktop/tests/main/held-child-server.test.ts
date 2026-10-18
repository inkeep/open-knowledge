import { ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { getSystemErrorMap } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import { heldChildServer } from '../../src/main/window-manager.ts';

function libuvErrno(name: string): number {
  for (const [errno, [errName]] of getSystemErrorMap()) if (errName === name) return errno;
  throw new Error(`libuv has no error named ${name}`);
}

function childWithHandle(handle: { kill(signal: number): number } | null): ChildProcess {
  const child = Object.create(ChildProcess.prototype) as ChildProcess & { _handle: unknown };
  child._handle = handle;
  child.on('error', () => {});
  return child;
}

function thrownBy(signal: () => void): unknown {
  try {
    signal();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('heldChildServer', () => {
  test('delivers the signal through the held child', () => {
    const kill = vi.fn((_signal: number) => 0);
    const server = heldChildServer(childWithHandle({ kill }), 4242, () => null);

    expect(thrownBy(() => server.signal('SIGKILL'))).toBeUndefined();
    expect(kill).toHaveBeenCalledWith(constants.signals.SIGKILL);
  });

  test('throws the errno the operating system refused the signal with', () => {
    const server = heldChildServer(
      childWithHandle({ kill: () => libuvErrno('EPERM') }),
      4242,
      () => null,
    );

    expect(thrownBy(() => server.signal('SIGKILL'))).toMatchObject({
      code: 'EPERM',
      syscall: 'kill',
    });
  });

  test('throws ESRCH when the operating system reports no such process', () => {
    const server = heldChildServer(
      childWithHandle({ kill: () => libuvErrno('ESRCH') }),
      4242,
      () => null,
    );

    expect(thrownBy(() => server.signal('SIGTERM'))).toMatchObject({ code: 'ESRCH' });
  });

  test('throws ESRCH once the held child has exited and released its handle', () => {
    const server = heldChildServer(childWithHandle(null), 4242, () => ({ code: 0, signal: null }));

    expect(thrownBy(() => server.signal('SIGTERM'))).toMatchObject({ code: 'ESRCH' });
  });
});
