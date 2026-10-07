import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createUserConfigDispatch, createUserConfigStore } from './user-config-ipc.ts';

const dirs: string[] = [];
function tmpHome(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ok-user-config-ipc-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function userConfigPath(home: string): string {
  return resolveConfigPath('user', home, home);
}

function writeUserConfig(home: string, text: string): void {
  const path = userConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

function readUserConfig(home: string): Record<string, unknown> {
  return parseYaml(readFileSync(userConfigPath(home), 'utf-8')) as Record<string, unknown>;
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('createUserConfigStore', () => {
  test('reads an absent user config as empty text', async () => {
    const store = createUserConfigStore({ homedir: tmpHome() });
    await expect(store.read()).resolves.toEqual({ text: '' });
  });

  test('reads the current user config text', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const store = createUserConfigStore({ homedir: home });
    await expect(store.read()).resolves.toEqual({ text: 'appearance:\n  theme: dark\n' });
  });

  test('a patch lands in the user config and returns the new file text', async () => {
    const home = tmpHome();
    const store = createUserConfigStore({ homedir: home });
    const result = await store.patch({ editor: { wordWrap: false } });
    expect(result.ok).toBe(true);
    expect(readUserConfig(home)).toMatchObject({ editor: { wordWrap: false } });
    if (result.ok) expect(result.text).toBe(readFileSync(userConfigPath(home), 'utf-8'));
  });

  test('a patch keeps a key another writer landed after the renderer last read the file', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const store = createUserConfigStore({ homedir: home });
    await store.read();
    writeUserConfig(home, 'appearance:\n  theme: dark\n  language: fr\n');

    const result = await store.patch({ editor: { wordWrap: false } });

    expect(result.ok).toBe(true);
    expect(readUserConfig(home)).toMatchObject({
      appearance: { theme: 'dark', language: 'fr' },
      editor: { wordWrap: false },
    });
  });

  test('concurrent patches from two writers both land', async () => {
    const home = tmpHome();
    const store = createUserConfigStore({ homedir: home });
    const other = createUserConfigStore({ homedir: home });
    const [a, b] = await Promise.all([
      store.patch({ editor: { wordWrap: false } }),
      other.patch({ appearance: { theme: 'light' } }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(readUserConfig(home)).toMatchObject({
      editor: { wordWrap: false },
      appearance: { theme: 'light' },
    });
  });

  test('a project-scope key is refused and the file is untouched', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const store = createUserConfigStore({ homedir: home });
    const result = await store.patch({ content: { dir: 'docs' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SCOPE_VIOLATION');
    expect(readFileSync(userConfigPath(home), 'utf-8')).toBe('appearance:\n  theme: dark\n');
  });

  test('a schema-invalid value is refused and the file is untouched', async () => {
    const home = tmpHome();
    const store = createUserConfigStore({ homedir: home });
    const result = await store.patch({ editor: { wordWrap: 'sometimes' as unknown as boolean } });
    expect(result.ok).toBe(false);
    expect(existsSync(userConfigPath(home))).toBe(false);
  });

  test('watch reports an external edit and stops after unsubscribe', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const store = createUserConfigStore({ homedir: home, pollIntervalMs: 20 });
    const seen: string[] = [];
    const stop = store.watch(({ text }) => seen.push(text));
    writeUserConfig(home, 'appearance:\n  theme: light\n');
    await waitFor(() => seen.includes('appearance:\n  theme: light\n'));
    stop();
    writeUserConfig(home, 'appearance:\n  theme: system\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).not.toContain('appearance:\n  theme: system\n');
  });

  test('watch reports an edit only once the file reads the same on two consecutive polls', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const store = createUserConfigStore({ homedir: home, pollIntervalMs: 400 });
    const seen: string[] = [];
    const stop = store.watch(({ text }) => seen.push(text));
    writeUserConfig(home, 'appearance:\n  theme: li');
    await new Promise((r) => setTimeout(r, 600));
    writeUserConfig(home, 'appearance:\n  theme: light\n');
    await waitFor(() => seen.length > 0);
    stop();

    expect(seen).toEqual(['appearance:\n  theme: light\n']);
  });

  test('an unreadable user config is logged once, polling continues, and recovery is logged', async () => {
    const home = tmpHome();
    const path = userConfigPath(home);
    mkdirSync(path, { recursive: true });
    const log = fakeLog();
    const store = createUserConfigStore({ homedir: home, pollIntervalMs: 20, log });
    const seen: string[] = [];
    const stop = store.watch(({ text }) => seen.push(text));
    await expect(store.read()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 150));

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ err: expect.any(Error) });
    expect(seen).toEqual([]);

    rmSync(path, { recursive: true, force: true });
    writeUserConfig(home, 'appearance:\n  theme: light\n');
    await waitFor(() => seen.includes('appearance:\n  theme: light\n'));
    stop();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[1]).toContain('recovered');
  });

  test('a delivery that throws is logged once and retried on the next poll', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const log = fakeLog();
    const store = createUserConfigStore({ homedir: home, pollIntervalMs: 20, log });
    let failures = 3;
    const seen: string[] = [];
    const stop = store.watch(({ text }) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('render frame disposed');
      }
      seen.push(text);
    });
    writeUserConfig(home, 'appearance:\n  theme: light\n');
    await waitFor(() => seen.length > 0);
    stop();

    expect(seen).toEqual(['appearance:\n  theme: light\n']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

function fakeSender() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let onDestroyed: (() => void) | null = null;
  return {
    sent,
    destroy: () => onDestroyed?.(),
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
      isDestroyed: () => false,
      once: (_event: 'destroyed', listener: () => void) => {
        onDestroyed = listener;
      },
    },
  };
}

describe('createUserConfigDispatch', () => {
  test('forwards a language preference push', async () => {
    const setLanguagePreference = vi.fn();
    const dispatch = createUserConfigDispatch({
      store: createUserConfigStore({ homedir: tmpHome() }),
      setLanguagePreference,
    });
    await expect(
      dispatch(fakeSender().webContents, { kind: 'set-language-preference', preference: 'fr' }),
    ).resolves.toEqual({ ok: true });
    expect(setLanguagePreference).toHaveBeenCalledWith('fr');
  });

  test('read and patch reach the user config', async () => {
    const home = tmpHome();
    const dispatch = createUserConfigDispatch({
      store: createUserConfigStore({ homedir: home }),
      setLanguagePreference: () => {},
    });
    const sender = fakeSender().webContents;
    await expect(dispatch(sender, { kind: 'read' })).resolves.toEqual({ text: '' });
    const patched = await dispatch(sender, {
      kind: 'patch',
      patch: { appearance: { theme: 'dark' } },
    });
    expect(patched).toMatchObject({ ok: true });
    expect(readUserConfig(home)).toMatchObject({ appearance: { theme: 'dark' } });
  });

  test('a subscribed window is told about external edits until it is destroyed', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const dispatch = createUserConfigDispatch({
      store: createUserConfigStore({ homedir: home, pollIntervalMs: 20 }),
      setLanguagePreference: () => {},
    });
    const sender = fakeSender();
    await expect(dispatch(sender.webContents, { kind: 'subscribe' })).resolves.toEqual({
      ok: true,
    });
    writeUserConfig(home, 'appearance:\n  theme: light\n');
    await waitFor(() => sender.sent.length > 0);
    expect(sender.sent[0]).toEqual({
      channel: 'ok:user-config:changed',
      payload: { text: 'appearance:\n  theme: light\n' },
    });
    sender.destroy();
    const count = sender.sent.length;
    writeUserConfig(home, 'appearance:\n  theme: system\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(sender.sent.length).toBe(count);
  });

  test('a window stops being told about edits once its last subscription is released', async () => {
    const home = tmpHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    const dispatch = createUserConfigDispatch({
      store: createUserConfigStore({ homedir: home, pollIntervalMs: 20 }),
      setLanguagePreference: () => {},
    });
    const sender = fakeSender();
    await dispatch(sender.webContents, { kind: 'subscribe' });
    await dispatch(sender.webContents, { kind: 'subscribe' });
    await expect(dispatch(sender.webContents, { kind: 'unsubscribe' })).resolves.toEqual({
      ok: true,
    });
    writeUserConfig(home, 'appearance:\n  theme: light\n');
    await waitFor(() => sender.sent.length > 0);
    await dispatch(sender.webContents, { kind: 'unsubscribe' });
    const count = sender.sent.length;
    writeUserConfig(home, 'appearance:\n  theme: system\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(sender.sent.length).toBe(count);
  });

  test('a malformed request is rejected', async () => {
    const dispatch = createUserConfigDispatch({
      store: createUserConfigStore({ homedir: tmpHome() }),
      setLanguagePreference: () => {},
    });
    await expect(
      dispatch(fakeSender().webContents, { kind: 'bogus' } as unknown as { kind: 'read' }),
    ).rejects.toThrow();
  });
});
