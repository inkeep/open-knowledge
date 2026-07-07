/**
 * Integration tests for the four handoff IPC channels.
 *
 * Scope: this file verifies the WIRE contract — channel name + `createHandler`
 * + `createInvoker` + the impl functions that `main/index.ts` wires in —
 * composes correctly end-to-end. Unit-level coverage of impl behavior (each
 * deps-injected function's edge cases) lives at `tests/main/ipc-handlers.test.ts`;
 * this file's signal is that registration + invocation + rejection propagation
 * work when plugged through the real typed factories.
 *
 * What's newly tested here (not at the unit tier):
 *   - `ok:shell:open-external` routes each v0 scheme through `checkOutboundUrl`
 *     — proving the allowlist extension is actually reachable via IPC, not
 *     just via direct `checkOutboundUrl` calls in shell-allowlist.test.ts.
 *   - Rejections (bad scheme / invalid path / detect-failure / HOME unwritable)
 *     surface to the renderer as Promise rejections — a roundtrip
 *     must fail loudly, not silently return `undefined`.
 *   - Args splatted through the generic `ipc.invoke(channel, ...args)` land on
 *     the handler's positional args in order, preserving `RequestChannels` shape.
 *
 * Electron is NOT imported — a tiny in-memory bus pairs with `createHandler`
 * (bound to `ipcMain`) and `createInvoker` (bound to `ipcRenderer`). This is
 * the same pattern `tests/preload/bridge.test.ts` uses for its `createInvoker`
 * unit tests, extended so both ends see the same in-memory surface.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron';
import {
  detectProtocol as detectProtocolImpl,
  recordHandoff as recordHandoffImpl,
  showItemInFolder as showItemInFolderImpl,
  spawnCursor as spawnCursorImpl,
} from '../../src/main/ipc-handlers.ts';
import { checkOutboundUrl } from '../../src/main/shell-allowlist.ts';
import type { HandoffStatsLine } from '../../src/shared/ipc-channels.ts';
import { createHandler } from '../../src/shared/ipc-handler.ts';
import { createInvoker } from '../../src/shared/ipc-invoke.ts';

/**
 * Minimal in-memory IPC bus that mirrors the parts of `IpcMain` + `IpcRenderer`
 * that `createHandler` + `createInvoker` actually touch. Everything else
 * throws so an accidental use (e.g., `ipcMain.on`) fails loudly in test land.
 *
 * Rejection semantics mirror Electron: if a handler throws synchronously OR
 * returns a rejected Promise, the `invoke` Promise rejects. `await fn(...)`
 * in the invoke body gives us both behaviors for free.
 */
function createInMemoryIpcPair(): { ipcMain: IpcMain; ipcRenderer: IpcRenderer } {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();

  const fakeEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

  const ipcMain = {
    handle(channel: string, handler: Handler) {
      if (handlers.has(channel)) {
        throw new Error(`duplicate registration for ${channel}`);
      }
      handlers.set(channel, handler);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;

  const ipcRenderer = {
    async invoke(channel: string, ...args: unknown[]) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for ${channel}`);
      return await fn(fakeEvent, ...args);
    },
  } as unknown as IpcRenderer;

  return { ipcMain, ipcRenderer };
}

/**
 * Factory: build a fresh IPC pair + typed factories per test. Isolation means
 * one test's registrations can't leak into another — same discipline as the
 * integration harness in `handoff-api.test.ts`'s `beforeEach`.
 */
function setupRig() {
  const { ipcMain, ipcRenderer } = createInMemoryIpcPair();
  const handle = createHandler(ipcMain);
  const invoke = createInvoker(ipcRenderer);
  return { handle, invoke };
}

describe("'ok:shell:open-external' routes v0 schemes through the allowlist", () => {
  /**
   * Each scheme is exercised with the exact payload shape the `shell-allowlist.ts`
   * JSDoc documents. If `shell-allowlist.ts` ever narrows the allowlist or the URL
   * builders produce a new path segment, the matching test fires.
   */
  const ALLOWED_PAYLOADS: ReadonlyArray<[label: string, url: string]> = [
    [
      'Claude Cowork',
      'claude://cowork/new?q=test&folder=%2FUsers%2Fx%2Fproject&file=%2FUsers%2Fx%2Fdoc.md',
    ],
    ['Claude', 'claude://code/new?q=test&folder=%2FUsers%2Fx%2Fproject&file=%2FUsers%2Fx%2Fdoc.md'],
    ['Codex', 'codex://new?prompt=test&path=%2FUsers%2Fx%2Fproject'],
    [
      'Cursor',
      'cursor://anysphere.cursor-deeplink/prompt?text=encoded&workspace=project&mode=agent',
    ],
  ];

  for (const [label, url] of ALLOWED_PAYLOADS) {
    test(`passes ${label} URL through to shell.openExternal`, async () => {
      const { handle, invoke } = setupRig();
      const openExternal = mock((_url: string) => Promise.resolve());
      handle('ok:shell:open-external', async (_event, requested) => {
        const check = checkOutboundUrl(requested);
        if (!check.ok) {
          throw new Error(`shell.openExternal blocked: ${check.reason}`);
        }
        await openExternal(requested);
        return undefined;
      });

      const result = await invoke('ok:shell:open-external', url);
      expect(result).toBeUndefined();
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledWith(url);
    });
  }

  const BLOCKED_PAYLOADS: ReadonlyArray<[label: string, url: string]> = [
    ['file:', 'file:///etc/passwd'],
    ['ms-msdt: (Shabarkin 2022 class)', 'ms-msdt:/id/PCWDiagnostic'],
    ['javascript:', 'javascript:alert(1)'],
  ];

  for (const [label, url] of BLOCKED_PAYLOADS) {
    test(`rejects ${label} — allowlist gate runs before shell.openExternal`, async () => {
      const { handle, invoke } = setupRig();
      const openExternal = mock((_url: string) => Promise.resolve());
      handle('ok:shell:open-external', async (_event, requested) => {
        const check = checkOutboundUrl(requested);
        if (!check.ok) {
          throw new Error(`shell.openExternal blocked: ${check.reason}`);
        }
        await openExternal(requested);
        return undefined;
      });

      await expect(invoke('ok:shell:open-external', url)).rejects.toThrow(
        /shell\.openExternal blocked/,
      );
      expect(openExternal).not.toHaveBeenCalled();
    });
  }
});

describe("'ok:shell:detect-protocol' round-trips install state", () => {
  test('registered scheme returns {installed:true, displayName}', async () => {
    const { handle, invoke } = setupRig();
    handle('ok:shell:detect-protocol', async (_event, scheme) => {
      return detectProtocolImpl(
        {
          platform: 'darwin',
          getApplicationInfoForProtocol: async (url) => {
            expect(url).toBe('claude://');
            return { name: 'Claude', path: '/Applications/Claude.app' };
          },
        },
        scheme,
      );
    });

    const result = await invoke('ok:shell:detect-protocol', 'claude');
    expect(result).toEqual({ installed: true, displayName: 'Claude' });
  });

  test('unregistered scheme returns {installed:false} when Electron throws', async () => {
    const { handle, invoke } = setupRig();
    handle('ok:shell:detect-protocol', async (_event, scheme) => {
      return detectProtocolImpl(
        {
          platform: 'darwin',
          getApplicationInfoForProtocol: async () => {
            throw new Error('no handler registered');
          },
          // Stub the macOS LaunchServices fallback probe — without this, the
          // impl's fall-through path (`detectProtocol` line ~133) calls the
          // real `macOsProbeReal`, which queries the host's actual scheme
          // registrations and returns `installed:true` on developer machines
          // that have `codex://` installed locally. The test's intent is the
          // double-failure conservative fallback path.
          runMacOsProbe: async () => false,
        },
        scheme,
      );
    });

    const result = await invoke('ok:shell:detect-protocol', 'codex');
    expect(result).toEqual({ installed: false });
  });

  test('shell-injection-style scheme strings are rejected at the handler guard', async () => {
    const { handle, invoke } = setupRig();
    let electronCalled = 0;
    handle('ok:shell:detect-protocol', async (_event, scheme) => {
      return detectProtocolImpl(
        {
          platform: 'linux',
          getApplicationInfoForProtocol: async () => {
            electronCalled++;
            return { name: '', path: '' };
          },
          runXdgMime: async () => {
            electronCalled++;
            return { stdout: '', code: 0 };
          },
        },
        scheme,
      );
    });

    const result = await invoke('ok:shell:detect-protocol', '$(touch pwned)');
    expect(result).toEqual({ installed: false });
    expect(electronCalled).toBe(0);
  });
});

describe("'ok:shell:spawn-cursor' round-trips spawn outcomes", () => {
  test('valid path + successful spawn resolves to {ok:true}', async () => {
    const { handle, invoke } = setupRig();
    let spawnedExec: string | null = null;
    let spawnedArgs: ReadonlyArray<string> | null = null;
    handle('ok:shell:spawn-cursor', async (_event, path) => {
      return spawnCursorImpl(
        {
          platform: 'darwin',
          // Stub the CLI-shim resolver to null so this test deterministically
          // exercises the Electron `getApplicationInfoForProtocol` fallback —
          // without it, the real `resolveCursorBinaryDefault` probes the host
          // filesystem and returns `Contents/Resources/app/bin/cursor` on any
          // machine with Cursor installed, making the test pass-on-CI /
          // fail-on-dev-laptops.
          resolveCursorBinary: async () => null,
          getApplicationInfoForProtocol: async () => ({
            name: 'Cursor',
            path: '/Applications/Cursor.app/Contents/MacOS/Cursor',
          }),
          spawn: async (exec, args) => {
            spawnedExec = exec;
            spawnedArgs = args;
            return { ok: true };
          },
        },
        path,
      );
    });

    const result = await invoke('ok:shell:spawn-cursor', '/Users/x/project');
    expect(result).toEqual({ ok: true });
    expect(spawnedExec).toBe('/Applications/Cursor.app/Contents/MacOS/Cursor');
    expect(spawnedArgs).toEqual(['/Users/x/project']);
  });

  test('empty path resolves to {ok:false, reason:"invalid-path"} (no spawn, no resolve)', async () => {
    const { handle, invoke } = setupRig();
    let spawnCalled = 0;
    let resolveCalled = 0;
    handle('ok:shell:spawn-cursor', async (_event, path) => {
      return spawnCursorImpl(
        {
          platform: 'darwin',
          resolveCursorBinary: async () => null,
          getApplicationInfoForProtocol: async () => {
            resolveCalled++;
            return { name: '', path: '' };
          },
          spawn: async () => {
            spawnCalled++;
            return { ok: true };
          },
        },
        path,
      );
    });

    const result = await invoke('ok:shell:spawn-cursor', '');
    expect(result).toEqual({ ok: false, reason: 'invalid-path' });
    expect(spawnCalled).toBe(0);
    expect(resolveCalled).toBe(0);
  });

  test('relative path resolves to {ok:false, reason:"invalid-path"}', async () => {
    const { handle, invoke } = setupRig();
    handle('ok:shell:spawn-cursor', async (_event, path) => {
      return spawnCursorImpl(
        {
          platform: 'darwin',
          resolveCursorBinary: async () => null,
          getApplicationInfoForProtocol: async () => ({ name: '', path: '' }),
          spawn: async () => ({ ok: true }),
        },
        path,
      );
    });

    const result = await invoke('ok:shell:spawn-cursor', './project');
    expect(result).toEqual({ ok: false, reason: 'invalid-path' });
  });

  test('spawn timeout propagates through the wire as {ok:false, reason:"timeout"}', async () => {
    const { handle, invoke } = setupRig();
    handle('ok:shell:spawn-cursor', async (_event, path) => {
      return spawnCursorImpl(
        {
          platform: 'darwin',
          // See sibling test — null-stub the resolver so the test stays
          // hermetic regardless of whether Cursor.app is installed on the host.
          resolveCursorBinary: async () => null,
          getApplicationInfoForProtocol: async () => ({
            name: 'Cursor',
            path: '/Applications/Cursor.app/Contents/MacOS/Cursor',
          }),
          spawn: async () => ({ ok: false, reason: 'timeout' }),
        },
        path,
      );
    });

    const result = await invoke('ok:shell:spawn-cursor', '/Users/x/project');
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe("'ok:shell:show-item-in-folder' round-trips reveal outcomes", () => {
  // The wire's contract: result is `undefined` (silent-by-design — refusals
  // do NOT leak validation signal back to a potentially-compromised renderer).
  // What's observable through the wire is whether `shell.showItemInFolder` was
  // invoked + with what argument. Each test asserts both.
  test('valid path within project invokes shell.showItemInFolder', async () => {
    const { handle, invoke } = setupRig();
    const calls: string[] = [];
    handle('ok:shell:show-item-in-folder', async (_event, path) => {
      showItemInFolderImpl(
        {
          platform: 'darwin',
          projectPath: '/Users/x/project',
          showItemInFolder: (p) => calls.push(p),
        },
        path,
      );
      return undefined;
    });

    const result = await invoke('ok:shell:show-item-in-folder', '/Users/x/project/specs/foo.md');
    expect(result).toBeUndefined();
    expect(calls).toEqual(['/Users/x/project/specs/foo.md']);
  });

  test('undefined projectPath (Navigator window) refuses every path silently', async () => {
    const { handle, invoke } = setupRig();
    const calls: string[] = [];
    handle('ok:shell:show-item-in-folder', async (_event, path) => {
      showItemInFolderImpl(
        {
          platform: 'darwin',
          projectPath: undefined,
          showItemInFolder: (p) => calls.push(p),
        },
        path,
      );
      return undefined;
    });

    const result = await invoke('ok:shell:show-item-in-folder', '/Users/x/project/specs/foo.md');
    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('path outside project tree refuses silently', async () => {
    const { handle, invoke } = setupRig();
    const calls: string[] = [];
    handle('ok:shell:show-item-in-folder', async (_event, path) => {
      showItemInFolderImpl(
        {
          platform: 'darwin',
          projectPath: '/Users/x/project',
          showItemInFolder: (p) => calls.push(p),
        },
        path,
      );
      return undefined;
    });

    const result = await invoke('ok:shell:show-item-in-folder', '/Users/x/other/secrets.txt');
    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("'ok:shell:record-handoff' round-trips the stats append", () => {
  test('append success resolves the invoke promise to undefined', async () => {
    const { handle, invoke } = setupRig();
    const appendCalls: Array<{ path: string; content: string }> = [];
    const mkdirCalls: string[] = [];
    handle('ok:shell:record-handoff', async (_event, line) => {
      await recordHandoffImpl(
        {
          homedir: () => '/Users/test',
          appendFile: async (path, content) => {
            appendCalls.push({ path, content });
          },
          mkdir: async (path) => {
            mkdirCalls.push(path);
          },
        },
        line,
      );
      return undefined;
    });

    const line: HandoffStatsLine = {
      target: 'claude-cowork',
      host: 'electron',
      outcome: 'ok',
      ts: '2026-04-22T03:30:00.000Z',
    };
    const result = await invoke('ok:shell:record-handoff', line);
    expect(result).toBeUndefined();
    expect(mkdirCalls).toEqual(['/Users/test/.ok']);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]?.path).toBe('/Users/test/.ok/stats.jsonl');
    expect(JSON.parse(appendCalls[0]?.content.trim() ?? '')).toEqual(line);
  });

  test('HOME unwritable (appendFile throws EACCES) resolves to undefined — no wire-level throw', async () => {
    const { handle, invoke } = setupRig();
    const warnings: string[] = [];
    handle('ok:shell:record-handoff', async (_event, line) => {
      await recordHandoffImpl(
        {
          homedir: () => '/Users/test',
          appendFile: async () => {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          },
          mkdir: async () => {
            // Succeeds — failure is on append.
          },
          warn: (m) => warnings.push(m),
        },
        line,
      );
      return undefined;
    });

    const line: HandoffStatsLine = {
      target: 'cursor',
      host: 'electron',
      outcome: 'error',
      ts: '2026-04-22T03:31:00.000Z',
      reason: 'not-installed',
    };
    // Telemetry failure MUST NOT reject across the wire — dispatch path relies on
    // recordHandoff never taking down the renderer.
    await expect(invoke('ok:shell:record-handoff', line)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EACCES');
  });

  test('schema carries the optional `reason` field on error rows verbatim', async () => {
    const { handle, invoke } = setupRig();
    let capturedLine: HandoffStatsLine | null = null;
    handle('ok:shell:record-handoff', async (_event, line) => {
      await recordHandoffImpl(
        {
          homedir: () => '/Users/test',
          appendFile: async (_path, content) => {
            capturedLine = JSON.parse(content.trim()) as HandoffStatsLine;
          },
          mkdir: async () => {},
        },
        line,
      );
      return undefined;
    });

    const line: HandoffStatsLine = {
      target: 'cursor',
      host: 'electron',
      outcome: 'error',
      ts: '2026-04-22T03:32:00.000Z',
      reason: 'web-host-cursor-unsupported',
    };
    await invoke('ok:shell:record-handoff', line);
    expect(capturedLine).toEqual(line);
  });
});

describe('wire-level invariants', () => {
  test('unregistered channel rejects the invoke promise', async () => {
    const { invoke } = setupRig();
    await expect(
      // We cast through `unknown` because `RequestChannels` refuses the string at
      // compile time — the test's purpose is specifically to exercise the
      // runtime path when registration is missing.
      (invoke as unknown as (ch: string) => Promise<unknown>)('ok:shell:does-not-exist'),
    ).rejects.toThrow(/no handler registered/);
  });

  test('duplicate registration on the same channel is refused (defense-in-depth)', () => {
    const { handle } = setupRig();
    handle('ok:shell:open-external', async () => undefined);
    expect(() => {
      handle('ok:shell:open-external', async () => undefined);
    }).toThrow(/duplicate registration/);
  });

  test('positional args survive the roundtrip in order', async () => {
    const { handle, invoke } = setupRig();
    let captured: unknown;
    handle('ok:shell:record-handoff', async (_event, line) => {
      captured = line;
      return undefined;
    });

    const line: HandoffStatsLine = {
      target: 'codex',
      host: 'web',
      outcome: 'ok',
      ts: '2026-04-22T03:33:00.000Z',
    };
    await invoke('ok:shell:record-handoff', line);
    expect(captured).toEqual(line);
  });
});
