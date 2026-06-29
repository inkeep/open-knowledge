import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualSonner from 'sonner';
import type { OkLocalOpCloneEvent } from '@/lib/desktop-bridge-types';

const toast = {
  loading: mock((_message: string, _opts?: unknown) => 'toast-id'),
  success: mock((_message: string, _opts?: unknown) => {}),
  error: mock((_message: string, _opts?: unknown) => {}),
  info: mock((_message: string, _opts?: unknown) => {}),
  dismiss: mock((_id?: unknown) => {}),
};

mock.module('sonner', () => ({ ...actualSonner, toast }));

type CloneEvent = OkLocalOpCloneEvent | { type: 'complete'; port: number; dir: string };

function makeDeps(events: CloneEvent[]) {
  return {
    bridge: {
      dialog: { openFolder: mock(() => Promise.resolve('/parent')) },
    },
    authQueryTransport: {
      status: mock(() => Promise.resolve({ authenticated: false, host: 'github.com' })),
    },
    cloneTransport: {
      start: mock(() => ({
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        cancel: () => {},
      })),
    },
    openSignIn: mock(() => Promise.resolve(null)),
  };
}

describe('createCloneController().runClone failure handling', () => {
  afterEach(() => {
    for (const fn of [toast.loading, toast.success, toast.error, toast.info, toast.dismiss]) {
      fn.mockClear();
    }
  });

  test('clone error returns the raw message as `detail` and fires no error toast', async () => {
    const { createCloneController } = await import('./clone-controller');
    const deps = makeDeps([{ type: 'error', message: 'remote: Repository not found' }]);
    const controller = createCloneController(deps as never);

    const result = await controller.runClone({ url: 'https://github.com/o/r.git', branch: 'main' });

    expect(result).toEqual({ kind: 'error', detail: 'remote: Repository not found' });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalled();
  });

  test('cancelled folder picker returns cancelled without starting a clone', async () => {
    const { createCloneController } = await import('./clone-controller');
    const deps = makeDeps([]);
    deps.bridge.dialog.openFolder = mock(() => Promise.resolve(null));
    const controller = createCloneController(deps as never);

    const result = await controller.runClone({ url: 'https://github.com/o/r.git' });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(deps.cloneTransport.start).not.toHaveBeenCalled();
  });

  test('complete event returns ok with the cloned dir', async () => {
    const { createCloneController } = await import('./clone-controller');
    const deps = makeDeps([{ type: 'complete', dir: '/parent/r' }]);
    const controller = createCloneController(deps as never);

    const result = await controller.runClone({ url: 'https://github.com/o/r.git' });

    expect(result).toEqual({ kind: 'ok', dir: '/parent/r' });
  });

  test('stream that ends with no terminal event returns error and dismisses the toast', async () => {
    const { createCloneController } = await import('./clone-controller');
    const deps = makeDeps([]); // openFolder returns '/parent'; events stream is empty
    const controller = createCloneController(deps as never);

    const result = await controller.runClone({ url: 'https://github.com/o/r.git' });

    expect(result).toEqual({ kind: 'error', detail: 'Clone ended unexpectedly.' });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalled();
  });

  test('async iterator throw returns the message as detail and dismisses the toast', async () => {
    const { createCloneController } = await import('./clone-controller');
    const deps = {
      ...makeDeps([]),
      cloneTransport: {
        start: mock(() => ({
          events: {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(new Error('IPC channel closed')),
            }),
          },
          cancel: () => {},
        })),
      },
    };
    const controller = createCloneController(deps as never);

    const result = await controller.runClone({ url: 'https://github.com/o/r.git' });

    expect(result).toEqual({ kind: 'error', detail: 'IPC channel closed' });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalled();
  });

  test('synchronous start() throw still dismisses the progress toast (no leak)', async () => {
    const { createCloneController } = await import('./clone-controller');
    const deps = {
      ...makeDeps([]),
      cloneTransport: {
        start: mock(() => {
          throw new Error('clone IPC handler not registered');
        }),
      },
    };
    const controller = createCloneController(deps as never);

    const result = await controller.runClone({ url: 'https://github.com/o/r.git' });

    expect(result).toEqual({ kind: 'error', detail: 'clone IPC handler not registered' });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalled();
  });
});
