import { describe, expect, test } from 'vitest';
import { mergeLayered } from './merge-layered.ts';
import type { Config } from './schema.ts';
import { ConfigSchema } from './schema.ts';

function makeConfig(partial: Record<string, unknown>): Config {
  return ConfigSchema.parse(partial);
}

describe('mergeLayered — default precedence (no scope-aware short-circuit)', () => {
  test('project-local > project > user for a deep-merged object branch', () => {
    const user = makeConfig({ chrome: { foo: 'u', shared: 'u' } });
    const project = makeConfig({ chrome: { foo: 'p', extra: 'p' } });
    const projectLocal = makeConfig({ chrome: { foo: 'pl', mine: 'pl' } });

    const merged = mergeLayered(user, project, projectLocal) as Config & {
      chrome: { foo: string; shared: string; extra: string; mine: string };
    };
    expect(merged.chrome.foo).toBe('pl');
    expect(merged.chrome.shared).toBe('u');
    expect(merged.chrome.extra).toBe('p');
    expect(merged.chrome.mine).toBe('pl');
  });

  test('arrays replace wholesale at the highest non-undefined layer', () => {
    const user = makeConfig({ chrome: { tags: ['u1', 'u2'] } });
    const project = makeConfig({ chrome: { tags: ['p1'] } });
    const projectLocal = makeConfig({ chrome: { tags: ['pl1', 'pl2', 'pl3'] } });

    const merged = mergeLayered(user, project, projectLocal) as Config & {
      chrome: { tags: string[] };
    };
    expect(merged.chrome.tags).toEqual(['pl1', 'pl2', 'pl3']);
  });

  test('null at project-local short-circuits to null (clear semantics)', () => {
    const user = makeConfig({ chrome: { foo: 'u' } });
    const project = makeConfig({ chrome: { foo: 'p' } });
    const projectLocal = makeConfig({ chrome: { foo: null } });

    const merged = mergeLayered(user, project, projectLocal) as Config & {
      chrome: { foo: string | null };
    };
    expect(merged.chrome.foo).toBeNull();
  });

  test('undefined leaf at project-local falls through to project', () => {
    const user = makeConfig({ chrome: { foo: 'u' } });
    const project = makeConfig({ chrome: { foo: 'p' } });
    const projectLocal = makeConfig({ chrome: {} });

    const merged = mergeLayered(user, project, projectLocal) as Config & {
      chrome: { foo: string };
    };
    expect(merged.chrome.foo).toBe('p');
  });
});

describe('mergeLayered — scope-aware leaf short-circuits', () => {
  test("scope: 'user' (appearance.theme) returns user even when project + project-local set it", () => {
    const user = makeConfig({ appearance: { theme: 'dark' } });
    const project = makeConfig({ appearance: { theme: 'light' } });
    const projectLocal = makeConfig({ appearance: { theme: 'system' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.appearance?.theme).toBe('dark');
  });

  test("scope: 'user' returns user even when user-side is undefined (no fallback)", () => {
    const user = makeConfig({ appearance: {} });
    const project = makeConfig({ appearance: { theme: 'dark' } });
    const projectLocal = makeConfig({ appearance: { theme: 'light' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.appearance?.theme).toBeUndefined();
  });

  test("scope: 'user' (appearance.language) ignores a project-layer language entirely", () => {
    const user = makeConfig({ appearance: {} });
    const project = makeConfig({ appearance: { language: 'es' } });
    const projectLocal = makeConfig({ appearance: { language: 'zh-Hans' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.appearance?.language).toBeUndefined();
  });

  test("scope: 'user' (appearance.language) keeps the 'system' sentinel the user stored", () => {
    const user = makeConfig({ appearance: { language: 'system' } });
    const project = makeConfig({ appearance: { language: 'es' } });
    const projectLocal = makeConfig({ appearance: { language: 'zh-Hans' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.appearance?.language).toBe('system');
  });

  test("scope: 'user' (editor.wordWrap) returns user preference even when other layers differ", () => {
    const user = makeConfig({ editor: { wordWrap: false } });
    const project = makeConfig({ editor: { wordWrap: true } });
    const projectLocal = makeConfig({ editor: { wordWrap: true } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.editor?.wordWrap).toBe(false);
  });

  test("scope: 'user' (editor.previewTabs) returns user preference even when other layers differ", () => {
    const user = makeConfig({ editor: { previewTabs: false } });
    const project = makeConfig({ editor: { previewTabs: true } });
    const projectLocal = makeConfig({ editor: { previewTabs: true } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.editor?.previewTabs).toBe(false);
  });

  test("scope: 'project' (content.dir) returns project, ignoring project-local", () => {
    const user = makeConfig({ content: { dir: './user' } });
    const project = makeConfig({ content: { dir: './project' } });
    const projectLocal = makeConfig({ content: { dir: './local' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.content?.dir).toBe('./project');
  });

  test("scope: 'project-local' (autoSync.enabled) returns project-local, ignoring project + user", () => {
    const user = makeConfig({ autoSync: { enabled: false } });
    const project = makeConfig({ autoSync: { enabled: false } });
    const projectLocal = makeConfig({ autoSync: { enabled: true } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBe(true);
  });

  test("scope: 'project-local' = false short-circuits even when project = true", () => {
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });
    const projectLocal = makeConfig({ autoSync: { enabled: false } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBe(false);
  });

  test("scope: 'project-local' with null local no longer inherits the committed project value", () => {
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });
    const projectLocal = makeConfig({ autoSync: { enabled: null } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBeNull();
  });

  test("scope: 'project-local' returns null when every layer is null (no fallback below user)", () => {
    const user = makeConfig({ autoSync: { enabled: null } });
    const project = makeConfig({ autoSync: { enabled: null } });
    const projectLocal = makeConfig({ autoSync: { enabled: null } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBeNull();
  });

  test("scope: 'project-local' unset locally ignores the committed project value", () => {
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });
    const projectLocal = makeConfig({ autoSync: {} });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBeNull();
  });

  test("scope: 'project-local' falls through to user when project + project-local both omit it", () => {
    const user = makeConfig({ autoSync: { enabled: true } });
    const project = makeConfig({ autoSync: {} });
    const projectLocal = makeConfig({ autoSync: {} });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBe(true);
  });

  test("scope: 'project-local' (terminal.enabled) returns the project-local grant, ignoring project + user", () => {
    const user = makeConfig({});
    const project = makeConfig({});
    const projectLocal = makeConfig({ terminal: { enabled: true } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.terminal?.enabled).toBe(true);
  });

  test("scope: 'project-local' (terminal.shell) returns only the machine-local override", () => {
    const user = makeConfig({ terminal: { shell: 'user-shell.exe' } });
    const project = makeConfig({ terminal: { shell: 'project-shell.exe' } });
    const projectLocal = makeConfig({ terminal: { shell: 'C:\\Tools\\pwsh.exe' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.terminal?.shell).toBe('C:\\Tools\\pwsh.exe');
  });

  test('a clone without the project-local layer resolves terminal.enabled to null (grant never inherited)', () => {
    const user = makeConfig({});
    const project = makeConfig({});

    const merged = mergeLayered(user, project);
    expect(merged.terminal?.enabled).toBeNull();
  });

  test("scope: 'project-local' (server.bind) ignores a committed project value; the project-local layer wins", () => {
    const user = makeConfig({});
    const project = makeConfig({ server: { bind: ['0.0.0.0'] } });
    const projectLocal = makeConfig({ server: { bind: ['192.168.1.5'] } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.server?.bind).toEqual(['192.168.1.5']);
  });

  test('a clone with a committed non-loopback bind but no project-local layer falls to the loopback default', () => {
    const user = makeConfig({});
    const project = makeConfig({ server: { bind: ['0.0.0.0'] } });
    const projectLocal = makeConfig({});

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.server?.bind).toEqual(['127.0.0.1']);
  });

  test('RAW-layer path: a committed bind is skipped; a user-global bind is honored as a personal default', () => {
    const committed = mergeLayered({}, { server: { bind: ['0.0.0.0'] } }, {});
    expect((committed.server as { bind?: string[] } | undefined)?.bind).toBeUndefined();

    const userDefault = mergeLayered(
      { server: { bind: ['::1'] } },
      { server: { bind: ['0.0.0.0'] } },
      {},
    );
    expect((userDefault.server as { bind?: string[] } | undefined)?.bind).toEqual(['::1']);
  });

  test("scope: 'project-local' (server.allowExternal) ignores a committed project value", () => {
    const user = makeConfig({});
    const project = makeConfig({ server: { allowExternal: true } });
    const projectLocal = makeConfig({});

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.server?.allowExternal).toBe(false);
  });
});

describe('mergeLayered — backward compat for two-layer call sites', () => {
  test('mergeLayered(user, project) compiles and returns project-over-user merge', () => {
    const user = makeConfig({ chrome: { foo: 'u', shared: 'u' } });
    const project = makeConfig({ chrome: { foo: 'p', extra: 'p' } });

    const merged = mergeLayered(user, project) as Config & {
      chrome: { foo: string; shared: string; extra: string };
    };
    expect(merged.chrome.foo).toBe('p');
    expect(merged.chrome.shared).toBe('u');
    expect(merged.chrome.extra).toBe('p');
  });

  test('mergeLayered(user, project) preserves scope: user short-circuit', () => {
    const user = makeConfig({ appearance: { theme: 'dark' } });
    const project = makeConfig({ appearance: { theme: 'light' } });

    const merged = mergeLayered(user, project);
    expect(merged.appearance?.theme).toBe('dark');
  });

  test('mergeLayered(user, project) ignores a committed project-local-scope value', () => {
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });

    const merged = mergeLayered(user, project);
    expect(merged.autoSync?.enabled).toBeNull();
  });

  test('a committed allowExternal:true never passes through, even via the two-layer merge', () => {
    const user = makeConfig({});
    const project = makeConfig({ server: { allowExternal: true } });

    const merged = mergeLayered(user, project);
    expect(merged.server?.allowExternal).toBe(false);
  });

  test('RAW-layer path: a committed allowExternal is skipped, an unset local leaf falls to the schema default', () => {
    const committedLeak = mergeLayered({}, { server: { allowExternal: true } }, {});
    expect(
      (committedLeak.server as { allowExternal?: boolean } | undefined)?.allowExternal,
    ).toBeUndefined();

    const userGlobalDefault = mergeLayered(
      { server: { allowExternal: true } },
      { server: { allowExternal: false } },
      {},
    );
    expect(
      (userGlobalDefault.server as { allowExternal?: boolean } | undefined)?.allowExternal,
    ).toBe(true);
  });
});

describe('mergeLayered — structural edges', () => {
  test('does not mutate input layers (returns new object trees)', () => {
    const user = makeConfig({ chrome: { foo: 'u' } });
    const project = makeConfig({ chrome: { foo: 'p' } });
    const projectLocal = makeConfig({ chrome: { foo: 'pl' } });
    const userBefore = JSON.stringify(user);
    const projectBefore = JSON.stringify(project);
    const projectLocalBefore = JSON.stringify(projectLocal);

    mergeLayered(user, project, projectLocal);

    expect(JSON.stringify(user)).toBe(userBefore);
    expect(JSON.stringify(project)).toBe(projectBefore);
    expect(JSON.stringify(projectLocal)).toBe(projectLocalBefore);
  });

  test('returned root is a plain object (not the input reference)', () => {
    const user = makeConfig({ chrome: { foo: 'u' } });
    const project = makeConfig({ chrome: { foo: 'p' } });
    const projectLocal = makeConfig({ chrome: { foo: 'pl' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged).not.toBe(user);
    expect(merged).not.toBe(project);
    expect(merged).not.toBe(projectLocal);
  });

  test('project-local-only top-level key surfaces in the merge', () => {
    const user = makeConfig({});
    const project = makeConfig({});
    const projectLocal = makeConfig({ chrome: { onlyHere: 'pl' } });

    const merged = mergeLayered(user, project, projectLocal) as Config & {
      chrome: { onlyHere: string };
    };
    expect(merged.chrome.onlyHere).toBe('pl');
  });
});
