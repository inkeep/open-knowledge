/**
 * Per-project consent dialog — main-side IPC + lifecycle.
 *
 * Pure-function tests against an injected `ConsentIpcMainLike` stub. No real
 * Electron runtime, no real fs writes (the probe walk uses real fs to enable
 * an integration assertion against a tmp-dir fixture).
 */
import { describe, expect, test } from 'bun:test';
import type { Dirent } from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OnboardingConfirmRequest, OnboardingShowPayload } from '../shared/ipc-channels.ts';
import {
  type ConsentIpcMainLike,
  PROBE_WALK_CAP,
  type PreviewContentFn,
  requestUserConsent,
  runProbe,
  walkExceedsCap,
} from './consent-dialog.ts';

interface IpcStub extends ConsentIpcMainLike {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>;
  invoke(channel: string, senderId: number, ...args: unknown[]): Promise<unknown>;
  bindSender(id: number): Promise<Array<{ channel: string; args: unknown[] }>>;
}

function createIpcStub(): IpcStub {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
  >();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler as (e: unknown, ...a: unknown[]) => unknown);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    async invoke(channel, senderId, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({ sender: { id: senderId } }, ...args);
    },
    async bindSender(id) {
      const ready = handlers.get('ok:onboarding:renderer-ready');
      if (!ready) throw new Error('renderer-ready handler not registered');
      const captured: Array<{ channel: string; args: unknown[] }> = [];
      const event = {
        sender: {
          id,
          send(channel: string, ...args: unknown[]) {
            captured.push({ channel, args });
          },
          isDestroyed: () => false,
        },
      };
      await ready(event);
      return captured;
    },
  };
}

const SAMPLE_PAYLOAD: OnboardingShowPayload = {
  pickedPath: '/Users/me/proj',
  projectDir: '/Users/me/proj',
  defaultContentDir: '.',
  gitState: 'absent',
  gitRootPromoted: false,
  warnings: [],
  editorOptions: [
    { id: 'claude', label: 'Claude', hasProjectConfig: true },
    { id: 'cursor', label: 'Cursor', hasProjectConfig: true },
  ],
};

const SAMPLE_CONFIRM: OnboardingConfirmRequest = {
  initGit: true,
  contentDir: '.',
  additionalIgnores: '',
  editorIds: ['claude', 'cursor'],
  sharing: 'shared',
};

const fakePreview: PreviewContentFn = () => ({
  totalCount: 3,
  sample: ['a.md', 'b.md', 'c.md'],
  warnings: [],
});

function fakeNavigator() {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  return {
    webContents: {
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
      isDestroyed: () => false,
    },
    sent,
  };
}

describe('requestUserConsent — proactive show (real WebContents path)', () => {
  test('navigator with .id receives show event immediately, no renderer-ready needed', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const navigatorWithId = { ...navigator.webContents, id: 7 };
    const promise = requestUserConsent(
      { ipcMain, navigator: navigatorWithId, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    // Show event must have fired without bindSender — this proves the
    // proactive-show path is what makes the production flow work (the
    // renderer signals ready ONCE at module-init, well before openProject
    // registers the renderer-ready handler).
    expect(navigator.sent.find((s) => s.channel === 'ok:onboarding:show')).toBeDefined();
    // Confirm/cancel from the same sender id must be accepted (sender
    // captured eagerly).
    await ipcMain.invoke('ok:onboarding:confirm', 7, SAMPLE_CONFIRM);
    await expect(promise).resolves.toMatchObject({ outcome: 'confirm' });
  });

  test('navigator without .id falls back to renderer-ready handshake', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    // No .id on the webContents — proactive path must skip.
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    // Without .id, no proactive show fired.
    expect(navigator.sent.find((s) => s.channel === 'ok:onboarding:show')).toBeUndefined();
    // Renderer-ready handshake still works.
    const captured = await ipcMain.bindSender(1);
    expect(captured.find((c) => c.channel === 'ok:onboarding:show')).toBeDefined();
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await promise;
  });
});

describe('requestUserConsent — mount-ack handshake', () => {
  test('renderer-ready dispatches show event back to caller', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    const captured = await ipcMain.bindSender(1);
    expect(captured.find((c) => c.channel === 'ok:onboarding:show')).toBeDefined();
    // Promise still pending — caller must invoke confirm/cancel.
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await expect(promise).resolves.toEqual({ outcome: 'cancel' });
  });

  test('renderer-ready handler stays armed until settle (so navigator reload + listener-not-bound races can re-dispatch)', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    // Handler stays armed after the first dispatch — disarming early would
    // trap a re-arming renderer (mid-reload) without a way to re-dispatch.
    expect(ipcMain.handlers.has('ok:onboarding:renderer-ready')).toBe(true);
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await promise;
    // Handler is removed once the dialog resolves (teardown).
    expect(ipcMain.handlers.has('ok:onboarding:renderer-ready')).toBe(false);
  });
});

describe('requestUserConsent — proactive-show race (renderer-not-bound-yet)', () => {
  test('renderer-ready re-dispatches show after proactive send already captured the same-sender id', async () => {
    // Production race: navigator has `.id`, proactive `webContents.send` fires,
    // but the renderer hasn't yet attached its `ok:onboarding:show` listener
    // via the preload bridge (preload + renderer.attach race). Electron
    // silently drops the payload. Then the renderer mounts, binds its
    // listener, and calls `signalReady` — the renderer-ready handler MUST
    // re-dispatch the payload to event.sender so the dialog can render.
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const navigatorWithId = { ...navigator.webContents, id: 9 };
    const promise = requestUserConsent(
      { ipcMain, navigator: navigatorWithId, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    expect(navigator.sent.find((s) => s.channel === 'ok:onboarding:show')).toBeDefined();
    // Renderer mounts, signalReady arrives — same sender id as the navigator.
    const captured = await ipcMain.bindSender(9);
    expect(captured.find((c) => c.channel === 'ok:onboarding:show')).toBeDefined();
    await ipcMain.invoke('ok:onboarding:cancel', 9);
    await promise;
  });

  test('renderer-ready from a foreign sender (different .id) after proactive show is ignored', async () => {
    // Original window owns the session — a stray window's signalReady must
    // not cause main to push the payload to the foreign WebContents.
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const navigatorWithId = { ...navigator.webContents, id: 9 };
    const promise = requestUserConsent(
      { ipcMain, navigator: navigatorWithId, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    expect(navigator.sent.find((s) => s.channel === 'ok:onboarding:show')).toBeDefined();
    const captured = await ipcMain.bindSender(99);
    expect(captured.find((c) => c.channel === 'ok:onboarding:show')).toBeUndefined();
    await ipcMain.invoke('ok:onboarding:cancel', 9);
    await promise;
  });
});

describe('requestUserConsent — confirm', () => {
  test('confirm from bound sender resolves with the request', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    const result = await ipcMain.invoke('ok:onboarding:confirm', 1, SAMPLE_CONFIRM);
    expect(result).toEqual({ ok: true });
    const decision = await promise;
    expect(decision).toEqual({ outcome: 'confirm', request: SAMPLE_CONFIRM });
  });

  test('confirm from a different sender is rejected', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    const result = (await ipcMain.invoke('ok:onboarding:confirm', 999, SAMPLE_CONFIRM)) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    // Promise still pending.
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await promise;
  });

  test('confirm clamps editorIds to the show payload offered set', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    const bogus = {
      ...SAMPLE_CONFIRM,
      editorIds: ['claude', 'phantom-editor', 'cursor'],
    };
    await ipcMain.invoke('ok:onboarding:confirm', 1, bogus);
    const decision = (await promise) as { outcome: 'confirm'; request: OnboardingConfirmRequest };
    expect(decision.outcome).toBe('confirm');
    expect(decision.request.editorIds).toEqual(['claude', 'cursor']);
  });

  test('handlers are removed after resolution', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    await ipcMain.invoke('ok:onboarding:confirm', 1, SAMPLE_CONFIRM);
    await promise;
    expect(ipcMain.handlers.has('ok:onboarding:confirm')).toBe(false);
    expect(ipcMain.handlers.has('ok:onboarding:cancel')).toBe(false);
    expect(ipcMain.handlers.has('ok:onboarding:probe-content')).toBe(false);
  });

  test('confirm with `..`-escape contentDir is rejected — promise stays pending', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    const evil = { ...SAMPLE_CONFIRM, contentDir: '../../etc' };
    const result = (await ipcMain.invoke('ok:onboarding:confirm', 1, evil)) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Content directory must be inside the project');
    // Promise stays pending — let the test proceed by cancelling.
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await promise;
  });

  test('confirm with absolute contentDir is rejected', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    const evil = { ...SAMPLE_CONFIRM, contentDir: '/etc/passwd' };
    const result = (await ipcMain.invoke('ok:onboarding:confirm', 1, evil)) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await promise;
  });
});

describe('requestUserConsent — cancel', () => {
  test('cancel from bound sender resolves with cancel outcome', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await expect(promise).resolves.toEqual({ outcome: 'cancel' });
  });

  test('cancel from a different sender is rejected', async () => {
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: fakePreview },
      SAMPLE_PAYLOAD,
    );
    await ipcMain.bindSender(1);
    const result = (await ipcMain.invoke('ok:onboarding:cancel', 42)) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await promise;
  });
});

describe('runProbe', () => {
  test('returns ok with count + sample for a real tmp-dir fixture', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-probe-'));
    writeFileSync(join(tmp, 'a.md'), '# a');
    writeFileSync(join(tmp, 'b.md'), '# b');
    const recordedPreview: PreviewContentFn = ({ sampleCap }) => ({
      totalCount: 2,
      sample: ['a.md', 'b.md'].slice(0, sampleCap ?? 5),
      warnings: [],
    });
    const result = await runProbe(recordedPreview, tmp, { contentDir: '.' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(2);
      expect(result.sample).toEqual(['a.md', 'b.md']);
      expect(result.truncated).toBe(false);
    }
  });

  test('non-existent contentDir surfaces ok:false', async () => {
    const result = await runProbe(fakePreview, `/tmp/does-not-exist-${Date.now()}`, {
      contentDir: '.',
    });
    expect(result.ok).toBe(false);
  });

  test('PROBE_WALK_CAP equals 50,000 entries', () => {
    expect(PROBE_WALK_CAP).toBe(50_000);
  });

  test('small fixture is not truncated', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-probe-small-'));
    writeFileSync(join(tmp, 'one.md'), 'x');
    const result = await runProbe(fakePreview, tmp, { contentDir: '.' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.truncated).toBe(false);
  });

  test('throwing previewContent surfaces ok:false', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-probe-throw-'));
    writeFileSync(join(tmp, 'a.md'), '# a');
    const throwingPreview: PreviewContentFn = () => {
      throw new Error('synthetic boom');
    };
    const result = await runProbe(throwingPreview, tmp, { contentDir: '.' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('synthetic boom');
  });

  test('rejects `..`-escape contentDir without invoking previewContent', async () => {
    let invoked = false;
    const guardPreview: PreviewContentFn = () => {
      invoked = true;
      return { totalCount: 0, sample: [], warnings: [] };
    };
    const result = await runProbe(guardPreview, '/Users/me/proj', {
      contentDir: '../../etc',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Content directory must be inside the project');
    }
    expect(invoked).toBe(false);
  });

  test('rejects absolute contentDir without invoking previewContent', async () => {
    let invoked = false;
    const guardPreview: PreviewContentFn = () => {
      invoked = true;
      return { totalCount: 0, sample: [], warnings: [] };
    };
    const result = await runProbe(guardPreview, '/Users/me/proj', {
      contentDir: '/etc',
    });
    expect(result.ok).toBe(false);
    expect(invoked).toBe(false);
  });

  test('subdirectory contentDir resolves correctly', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-probe-subdir-'));
    mkdirSync(join(tmp, 'docs'));
    writeFileSync(join(tmp, 'docs', 'a.md'), '# a');
    let receivedContentDir = '';
    const captureFakePreview: PreviewContentFn = ({ contentDir }) => {
      receivedContentDir = contentDir;
      return { totalCount: 1, sample: ['a.md'], warnings: [] };
    };
    const result = await runProbe(captureFakePreview, tmp, {
      contentDir: 'docs',
    });
    expect(result.ok).toBe(true);
    expect(receivedContentDir).toBe(join(tmp, 'docs'));
  });
});

describe('walkExceedsCap — async chunked yields', () => {
  test('yields the event loop between chunks of entries', async () => {
    // Synthetic flat tree of 5,000 entries via injectable readdir — exercises
    // the chunkYieldEvery path without writing 5k files to disk. With a
    // synchronous walk, the only event-loop yield is the single setImmediate
    // gate inside runProbe (which we don't hit here — we call walkExceedsCap
    // directly), so the tickCounter would fire AT MOST ONCE between callsite
    // microtask boundaries. The async chunked walk must fire it many times.
    const fakeEntries = Array.from({ length: 5000 }, (_, i) => ({
      name: `f${i}.md`,
      isDirectory: () => false,
    })) as unknown as Dirent[];
    const fakeReaddir = (path: string): Promise<readonly Dirent[]> =>
      Promise.resolve(path === '/fake/root' ? fakeEntries : []);

    let yieldsDuringWalk = 0;
    let walkCompleted = false;
    const tickCounter = (): void => {
      if (walkCompleted) return;
      yieldsDuringWalk += 1;
      setImmediate(tickCounter);
    };
    setImmediate(tickCounter);

    const truncated = await walkExceedsCap('/fake/root', 50_000, {
      readdirImpl: fakeReaddir,
      chunkYieldEvery: 500,
    });
    walkCompleted = true;

    // 5000 entries / chunkYieldEvery 500 = ~10 yields; assert ≥5 to leave
    // headroom for scheduler ordering on slow CI.
    expect(yieldsDuringWalk).toBeGreaterThanOrEqual(5);
    expect(truncated).toBe(false);
  });

  test('returns truncated=true when entry count exceeds cap', async () => {
    const fakeEntries = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}.md`,
      isDirectory: () => false,
    })) as unknown as Dirent[];
    const fakeReaddir = (path: string): Promise<readonly Dirent[]> =>
      Promise.resolve(path === '/fake/root' ? fakeEntries : []);

    const truncated = await walkExceedsCap('/fake/root', 10, {
      readdirImpl: fakeReaddir,
      chunkYieldEvery: 1000,
    });
    expect(truncated).toBe(true);
  });
});

describe('requestUserConsent — probe-content pins to captured projectDir', () => {
  test('IPC probe-content uses captured payload.projectDir; renderer-supplied projectDir is ignored', async () => {
    // Threat model: a compromised renderer cannot redirect the probe's walk
    // root by inventing a `projectDir`. Main pins the walk to the projectDir
    // it captured when it dispatched `ok:onboarding:show`.
    const tmp = mkdtempSync(join(tmpdir(), 'ok-probe-pin-'));
    writeFileSync(join(tmp, 'a.md'), '# a');
    let capturedProjectDir = '';
    let capturedContentDir = '';
    const recordingPreview: PreviewContentFn = ({ projectDir, contentDir }) => {
      capturedProjectDir = projectDir;
      capturedContentDir = contentDir;
      return { totalCount: 1, sample: ['a.md'], warnings: [] };
    };
    const ipcMain = createIpcStub();
    const navigator = fakeNavigator();
    const payload: OnboardingShowPayload = { ...SAMPLE_PAYLOAD, pickedPath: tmp, projectDir: tmp };
    const promise = requestUserConsent(
      { ipcMain, navigator: navigator.webContents, previewContent: recordingPreview },
      payload,
    );
    await ipcMain.bindSender(1);
    // Compromised-renderer simulation: the wire shape is `{ contentDir }` only,
    // but a malicious sender could attempt to inject extra fields. The stub's
    // `invoke` is `unknown[]` so runtime injection is possible — we cast here
    // to express "extra fields a malicious renderer might smuggle in".
    const evilRequest = { projectDir: '/etc', contentDir: '.' } as unknown as {
      contentDir: string;
    };
    const result = (await ipcMain.invoke('ok:onboarding:probe-content', 1, evilRequest)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    // Critical assertion: the walk operated against the captured tmp dir, NOT
    // the renderer-supplied '/etc'. If runProbe ever reads projectDir from the
    // request again, this fails.
    expect(capturedProjectDir).toBe(tmp);
    expect(capturedContentDir).toBe(tmp);
    expect(capturedProjectDir).not.toBe('/etc');
    await ipcMain.invoke('ok:onboarding:cancel', 1);
    await promise;
  });
});
