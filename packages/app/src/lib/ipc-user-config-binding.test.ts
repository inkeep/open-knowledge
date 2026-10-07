import type { ConfigPatch } from '@inkeep/open-knowledge-core/config/schema';
import type {
  OkUserConfigBridge,
  OkUserConfigPatchResult,
  OkUserConfigSnapshot,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { describe, expect, test, vi } from 'vitest';
import { createIpcUserConfigBinding } from './ipc-user-config-binding';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTransport(initialText: string) {
  const read = deferred<OkUserConfigSnapshot>();
  const changeListeners = new Set<(snapshot: OkUserConfigSnapshot) => void>();
  const patchResponses: Array<Deferred<OkUserConfigPatchResult>> = [];
  const patches: ConfigPatch[] = [];
  let readCount = 0;
  let diskText = initialText;
  let readError: Error | null = null;
  let heldRead: Deferred<OkUserConfigSnapshot> | null = null;
  const transport: OkUserConfigBridge = {
    read: () => {
      readCount += 1;
      if (readCount === 1) return read.promise;
      if (heldRead) {
        const held = heldRead;
        heldRead = null;
        return held.promise;
      }
      return readError ? Promise.reject(readError) : Promise.resolve({ text: diskText });
    },
    patch: (patch) => {
      patches.push(patch);
      const response = deferred<OkUserConfigPatchResult>();
      patchResponses.push(response);
      return response.promise;
    },
    onChanged: (cb) => {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
  };
  return {
    transport,
    patches,
    patchResponses,
    finishInitialRead: async () => {
      read.resolve({ text: initialText });
      await flush();
    },
    failInitialRead: async (error: Error) => {
      read.reject(error);
      await flush();
    },
    setReadError: (error: Error | null) => {
      readError = error;
    },
    readCount: () => readCount,
    holdNextRead: () => {
      const held = deferred<OkUserConfigSnapshot>();
      heldRead = held;
      return held;
    },
    setDisk: (text: string) => {
      diskText = text;
    },
    emitChange: (text: string) => {
      diskText = text;
      for (const cb of changeListeners) cb({ text });
    },
    listenerCount: () => changeListeners.size,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function elapse(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await flush();
}

describe('createIpcUserConfigBinding', () => {
  test('is unsynced until the first read lands, then reflects the user config', async () => {
    const fake = fakeTransport('appearance:\n  theme: dark\n');
    const binding = createIpcUserConfigBinding(fake.transport);
    const onSynced = vi.fn();
    binding.subscribeSynced(onSynced);

    expect(binding.hasSynced()).toBe(false);
    expect(binding.patch({ editor: { wordWrap: false } })).toMatchObject({
      ok: false,
      error: { code: 'NOT_SYNCED' },
    });

    await fake.finishInitialRead();

    expect(binding.hasSynced()).toBe(true);
    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(binding.current().appearance?.theme).toBe('dark');
  });

  test('a patch updates current() at once and sends only the patch, not the whole file', async () => {
    const fake = fakeTransport('appearance:\n  theme: dark\n');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();

    const result = binding.patch({ editor: { wordWrap: false } });

    expect(result.ok).toBe(true);
    expect(binding.current().editor?.wordWrap).toBe(false);
    expect(fake.patches).toEqual([{ editor: { wordWrap: false } }]);
  });

  test('the written file text replaces the local copy, keeping keys another writer added', async () => {
    const fake = fakeTransport('appearance:\n  theme: dark\n');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();

    binding.patch({ editor: { wordWrap: false } });
    fake.patchResponses[0]?.resolve({
      ok: true,
      text: 'appearance:\n  theme: dark\n  language: fr\neditor:\n  wordWrap: false\n',
    });
    await flush();

    expect(binding.current().appearance?.language).toBe('fr');
    expect(binding.current().editor?.wordWrap).toBe(false);
  });

  test('a project-scope key is refused locally and never sent', async () => {
    const fake = fakeTransport('');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();

    const result = binding.patch({ content: { dir: 'docs' } });

    expect(result).toMatchObject({ ok: false, error: { code: 'SCOPE_VIOLATION' } });
    expect(fake.patches).toEqual([]);
  });

  test('an external edit updates current() and notifies subscribers without writing back', async () => {
    const fake = fakeTransport('appearance:\n  theme: dark\n');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();
    const listener = vi.fn();
    binding.subscribe(listener);

    fake.emitChange('appearance:\n  theme: light\n');

    expect(binding.current().appearance?.theme).toBe('light');
    expect(listener).toHaveBeenCalled();
    expect(fake.patches).toEqual([]);
  });

  test('a write the main process refuses reverts to the file and reports the error', async () => {
    const fake = fakeTransport('appearance:\n  theme: dark\n');
    const onRemoteRejected = vi.fn();
    const binding = createIpcUserConfigBinding(fake.transport, { onRemoteRejected });
    await fake.finishInitialRead();

    binding.patch({ appearance: { theme: 'light' } });
    expect(binding.current().appearance?.theme).toBe('light');
    fake.patchResponses[0]?.resolve({
      ok: false,
      error: { code: 'WRITE_ERROR', detail: 'disk full' },
    });
    await flush();

    expect(onRemoteRejected).toHaveBeenCalledWith({ code: 'WRITE_ERROR', detail: 'disk full' });
    expect(binding.current().appearance?.theme).toBe('dark');
  });

  test('a stale reply does not undo a newer optimistic patch', async () => {
    const fake = fakeTransport('');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();

    binding.patch({ editor: { wordWrap: false } });
    binding.patch({ appearance: { theme: 'light' } });
    fake.patchResponses[0]?.resolve({ ok: true, text: 'editor:\n  wordWrap: false\n' });
    await flush();

    expect(binding.current().appearance?.theme).toBe('light');
  });

  test('dispose stops listening for external edits', async () => {
    const fake = fakeTransport('');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();
    expect(fake.listenerCount()).toBe(1);

    binding.dispose();

    expect(fake.listenerCount()).toBe(0);
  });

  test('an external edit pushed while a patch is in flight is applied once the patch settles', async () => {
    const fake = fakeTransport('');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();

    binding.patch({ editor: { wordWrap: false } });
    fake.emitChange('editor:\n  wordWrap: false\nappearance:\n  theme: light\n');
    expect(binding.current().appearance?.theme).toBeUndefined();
    fake.patchResponses[0]?.resolve({ ok: true, text: 'editor:\n  wordWrap: false\n' });
    await flush();

    expect(binding.current().appearance?.theme).toBe('light');
    expect(binding.current().editor?.wordWrap).toBe(false);
  });

  test('a patch refused while another is in flight converges on the file once both settle', async () => {
    const fake = fakeTransport('appearance:\n  theme: dark\n');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();

    binding.patch({ appearance: { theme: 'light' } });
    binding.patch({ editor: { wordWrap: false } });
    fake.patchResponses[0]?.resolve({
      ok: false,
      error: { code: 'WRITE_ERROR', detail: 'disk full' },
    });
    await flush();
    fake.setDisk('appearance:\n  theme: dark\n  language: fr\neditor:\n  wordWrap: false\n');
    fake.patchResponses[1]?.resolve({
      ok: true,
      text: 'appearance:\n  theme: dark\neditor:\n  wordWrap: false\n',
    });
    await flush();

    expect(binding.current().appearance?.theme).toBe('dark');
    expect(binding.current().appearance?.language).toBe('fr');
  });

  test('a resync read that a newer patch overtakes is discarded and read again', async () => {
    const fake = fakeTransport('');
    const binding = createIpcUserConfigBinding(fake.transport);
    await fake.finishInitialRead();

    binding.patch({ editor: { wordWrap: false } });
    fake.emitChange('editor:\n  wordWrap: false\nappearance:\n  theme: light\n');
    const resync = fake.holdNextRead();
    fake.patchResponses[0]?.resolve({ ok: true, text: 'editor:\n  wordWrap: false\n' });
    await flush();
    expect(fake.readCount()).toBe(2);

    binding.patch({ appearance: { language: 'fr' } });
    const newest = 'editor:\n  wordWrap: false\nappearance:\n  theme: light\n  language: fr\n';
    fake.setDisk(newest);
    fake.patchResponses[1]?.resolve({ ok: true, text: newest });
    await flush();
    resync.resolve({ text: 'editor:\n  wordWrap: false\nappearance:\n  theme: light\n' });
    await flush();

    expect(fake.readCount()).toBe(3);
    expect(binding.current().appearance?.language).toBe('fr');
    expect(binding.current().appearance?.theme).toBe('light');
    binding.dispose();
  });

  test('a resync read that fails is retried until the binding adopts the file', async () => {
    const fake = fakeTransport('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const binding = createIpcUserConfigBinding(fake.transport, { readRetryMs: 5 });
      await fake.finishInitialRead();

      binding.patch({ editor: { wordWrap: false } });
      fake.emitChange('editor:\n  wordWrap: false\nappearance:\n  theme: light\n');
      fake.setReadError(new Error('EBUSY'));
      fake.patchResponses[0]?.resolve({ ok: true, text: 'editor:\n  wordWrap: false\n' });
      await elapse(30);

      expect(binding.current().appearance?.theme).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);

      fake.setReadError(null);
      await elapse(30);

      expect(binding.current().appearance?.theme).toBe('light');
      expect(binding.current().editor?.wordWrap).toBe(false);
      const reads = fake.readCount();
      await elapse(30);
      expect(fake.readCount()).toBe(reads);
      binding.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  test('dispose stops retrying a failed resync read', async () => {
    const fake = fakeTransport('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const binding = createIpcUserConfigBinding(fake.transport, { readRetryMs: 5 });
      await fake.finishInitialRead();
      binding.patch({ editor: { wordWrap: false } });
      fake.emitChange('appearance:\n  theme: light\n');
      fake.setReadError(new Error('EBUSY'));
      fake.patchResponses[0]?.resolve({ ok: true, text: 'editor:\n  wordWrap: false\n' });
      await flush();
      binding.dispose();
      const reads = fake.readCount();

      await elapse(30);

      expect(fake.readCount()).toBe(reads);
    } finally {
      warn.mockRestore();
    }
  });

  test('a failed first read reports the failure, then loads once the file can be read', async () => {
    vi.useFakeTimers();
    const fake = fakeTransport('');
    const onLoadFailedChange = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const binding = createIpcUserConfigBinding(fake.transport, {
        onLoadFailedChange,
        readRetryMs: 1_000,
      });
      fake.setReadError(new Error('EACCES'));
      fake.setDisk('appearance:\n  theme: dark\n');
      await fake.failInitialRead(new Error('EACCES'));

      expect(binding.hasSynced()).toBe(false);
      expect(onLoadFailedChange).toHaveBeenLastCalledWith(true);
      expect(fake.readCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(fake.readCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.readCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.readCount()).toBe(3);
      expect(binding.hasSynced()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);

      fake.setReadError(null);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fake.readCount()).toBe(4);
      expect(binding.hasSynced()).toBe(true);
      expect(binding.current().appearance?.theme).toBe('dark');
      expect(onLoadFailedChange).toHaveBeenLastCalledWith(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.readCount()).toBe(4);
      binding.dispose();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test('after a failed first read, a pushed change loads the config', async () => {
    const fake = fakeTransport('');
    const onLoadFailedChange = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const binding = createIpcUserConfigBinding(fake.transport, {
        onLoadFailedChange,
        readRetryMs: 60_000,
      });
      await fake.failInitialRead(new Error('EIO'));
      expect(onLoadFailedChange).toHaveBeenLastCalledWith(true);

      fake.emitChange('appearance:\n  theme: light\n');

      expect(binding.hasSynced()).toBe(true);
      expect(binding.current().appearance?.theme).toBe('light');
      expect(onLoadFailedChange).toHaveBeenLastCalledWith(false);
      binding.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  test('dispose stops retrying a failed first read', async () => {
    const fake = fakeTransport('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const binding = createIpcUserConfigBinding(fake.transport, { readRetryMs: 5 });
      fake.setReadError(new Error('EIO'));
      await fake.failInitialRead(new Error('EIO'));
      binding.dispose();
      const reads = fake.readCount();

      await elapse(30);

      expect(fake.readCount()).toBe(reads);
    } finally {
      warn.mockRestore();
    }
  });
});
