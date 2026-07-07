import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInvoker } from '../../src/shared/ipc-invoke.ts';

/**
 * Preload bridge unit tests.
 *
 * The bridge module itself imports `electron` (`contextBridge`, `ipcRenderer`)
 * which only works inside a real Electron preload context — Bun's test runner
 * can't load it. So the test exercises the BUILDING BLOCKS the preload uses
 * (`createInvoker` typed-IPC factory) against a mock ipcRenderer surface.
 *
 * Full end-to-end preload behavior is verified in the Playwright smoke
 * test (`tests/integration/m1-smoke.test.ts`) which launches a real Electron
 * BrowserWindow.
 */

describe('createInvoker (typed IPC factory)', () => {
  test('forwards channel + args to ipcRenderer.invoke verbatim', async () => {
    const invoke = mock((channel: string, ...args: unknown[]) =>
      Promise.resolve({ channel, args }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: minimal IpcRenderer-compatible mock
    const fakeIpc = { invoke } as any;
    const typedInvoker = createInvoker(fakeIpc);
    const result = await typedInvoker('ok:dialog:open-folder');
    expect(invoke).toHaveBeenCalledWith('ok:dialog:open-folder');
    expect(result).toEqual({ channel: 'ok:dialog:open-folder', args: [] });
  });

  test('passes positional args through (e.g., shell.openExternal URL)', async () => {
    const invoke = mock((channel: string, ...args: unknown[]) =>
      Promise.resolve({ channel, args }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: minimal IpcRenderer-compatible mock
    const fakeIpc = { invoke } as any;
    const typedInvoker = createInvoker(fakeIpc);
    await typedInvoker('ok:shell:open-external', 'https://example.com');
    expect(invoke).toHaveBeenCalledWith('ok:shell:open-external', 'https://example.com');
  });

  test('return type is awaited from invoke', async () => {
    const invoke = mock(() => Promise.resolve('/Users/test/picked-folder'));
    // biome-ignore lint/suspicious/noExplicitAny: minimal IpcRenderer-compatible mock
    const fakeIpc = { invoke } as any;
    const typedInvoker = createInvoker(fakeIpc);
    const result = await typedInvoker('ok:dialog:open-folder');
    expect(result).toBe('/Users/test/picked-folder');
  });
});

/**
 * Regression gate — every `ipcRenderer.on(...)` / `ipcRenderer.removeListener(...)`
 * channel-name literal in the preload bridge MUST appear as a key in
 * `shared/ipc-events.ts`'s `EventChannels` interface. Without this check, a
 * typo in the preload (e.g., `ok:project-switched` vs canonical
 * `ok:project:switched`) silently makes the subscription a no-op — the typed
 * EventChannels map exists specifically to prevent this, but the current
 * preload invokes raw `ipcRenderer` calls where a string typo isn't caught at
 * compile time.
 */
describe('preload channel names are declared in EventChannels', () => {
  const PRELOAD_PATH = join(__dirname, '..', '..', 'src', 'preload', 'index.ts');
  const EVENTS_PATH = join(__dirname, '..', '..', 'src', 'shared', 'ipc-events.ts');

  test('every ipcRenderer subscription in preload matches an EventChannels key', () => {
    const preloadSrc = readFileSync(PRELOAD_PATH, 'utf-8');
    const eventsSrc = readFileSync(EVENTS_PATH, 'utf-8');

    // Extract `'ok:...'` literals passed to `ipcRenderer.on(...)` /
    // `ipcRenderer.removeListener(...)` / `ipcRenderer.once(...)`.
    const subscriptionPattern = /ipcRenderer\.(?:on|removeListener|once)\(\s*'(ok:[^']+)'/g;
    const usedChannels = new Set<string>();
    for (const m of preloadSrc.matchAll(subscriptionPattern)) {
      if (m[1]) usedChannels.add(m[1]);
    }

    // Extract declared keys from `EventChannels` interface (format: `'ok:...':`).
    const declarationPattern = /^\s*'(ok:[^']+)'\s*:/gm;
    const declaredChannels = new Set<string>();
    for (const m of eventsSrc.matchAll(declarationPattern)) {
      if (m[1]) declaredChannels.add(m[1]);
    }

    expect(usedChannels.size).toBeGreaterThan(0);
    expect(declaredChannels.size).toBeGreaterThan(0);

    const undeclared = Array.from(usedChannels).filter((ch) => !declaredChannels.has(ch));
    if (undeclared.length > 0) {
      throw new Error(
        [
          'preload subscribes to channel names that are not declared in EventChannels:',
          ...undeclared.map((ch) => `  - ${ch}`),
          '',
          `Declared channels: ${Array.from(declaredChannels).join(', ')}`,
          'Fix: rename the preload channel literal OR add the channel to `shared/ipc-events.ts`.',
        ].join('\n'),
      );
    }
    expect(undeclared).toEqual([]);
  });

  test('ok:deep-link is wired (M4 URL-scheme preload handshake)', () => {
    const preloadSrc = readFileSync(PRELOAD_PATH, 'utf-8');
    const eventsSrc = readFileSync(EVENTS_PATH, 'utf-8');
    expect(preloadSrc).toContain("ipcRenderer.on('ok:deep-link'");
    expect(preloadSrc).toContain("ipcRenderer.removeListener('ok:deep-link'");
    expect(eventsSrc).toContain("'ok:deep-link'");
  });
});
