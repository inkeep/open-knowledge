import { describe, expect, test } from 'bun:test';
import { mergeLayered } from './merge-layered.ts';
import type { Config } from './schema.ts';
import { ConfigSchema } from './schema.ts';

function makeConfig(partial: Record<string, unknown>): Config {
  // `looseObject` lets us inject extra keys at any depth — tests poke at
  // both registered scoped fields (appearance.theme, content.dir,
  // autoSync.enabled) and unregistered free-form keys.
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

  test("scope: 'user' (editor.wordWrap) returns user preference even when other layers differ", () => {
    const user = makeConfig({ editor: { wordWrap: false } });
    const project = makeConfig({ editor: { wordWrap: true } });
    const projectLocal = makeConfig({ editor: { wordWrap: true } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.editor?.wordWrap).toBe(false);
  });

  test("scope: 'project' (content.dir) returns project, ignoring project-local", () => {
    // `content.dir` is a `scope: 'project'` leaf. The project-over-project-local
    // short-circuit applies — pinning here so the scope: 'project'
    // branch in mergeLayered doesn't lose coverage.
    const user = makeConfig({ content: { dir: './user' } });
    const project = makeConfig({ content: { dir: './project' } });
    const projectLocal = makeConfig({ content: { dir: './local' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.content?.dir).toBe('./project');
  });

  // Sibling test "scope: 'project' falls back to user when project
  // undefined" was deleted alongside `preview.baseUrl`. The current
  // `scope: 'project'` fields carry Zod defaults, so the "project undefined"
  // branch of the short-circuit can't be cleanly exercised through them.
  // Restore an equivalent test here if a project-strict field without a
  // default is reintroduced.

  test("scope: 'project-local' (autoSync.enabled) returns project-local, ignoring project + user", () => {
    const user = makeConfig({ autoSync: { enabled: false } });
    const project = makeConfig({ autoSync: { enabled: false } });
    const projectLocal = makeConfig({ autoSync: { enabled: true } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBe(true);
  });

  test("scope: 'project-local' = false short-circuits even when project = true", () => {
    // Inverse of the previous test — pins that `false` is a real value (not
    // treated as absent / falsy fallthrough). Without this, `??` semantics
    // could silently degrade to `||` and a user explicitly opting out of
    // auto-sync on this machine would inherit project: true on next read.
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });
    const projectLocal = makeConfig({ autoSync: { enabled: false } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBe(false);
  });

  test("scope: 'project-local' falls back to project when project-local is null (backward compat)", () => {
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });
    const projectLocal = makeConfig({ autoSync: { enabled: null } });

    // `??` treats null + undefined alike — null in project-local falls through
    // to project, mirroring the existing scope: 'project' (project ?? user)
    // contract. This matches the server's readProjectAutoSyncEnabled which
    // checks `!== null && !== undefined` before short-circuiting.
    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBe(true);
  });

  test("scope: 'project-local' returns null when every layer is null (no fallback below user)", () => {
    const user = makeConfig({ autoSync: { enabled: null } });
    const project = makeConfig({ autoSync: { enabled: null } });
    const projectLocal = makeConfig({ autoSync: { enabled: null } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBeNull();
  });

  test("scope: 'project-local' falls through to project when project-local has no key", () => {
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });
    const projectLocal = makeConfig({ autoSync: {} });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.autoSync?.enabled).toBe(true);
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

  test('a clone without the project-local layer resolves terminal.enabled to null (grant never inherited)', () => {
    // Simulates a fresh clone/checkout: the gitignored .ok/local/ layer is
    // absent, and terminal.enabled can never sit in the committed project file
    // or the user file (the write gate rejects it at any other scope). With no
    // project-local layer the resolution must fall to the schema default null,
    // never silently inheriting a teammate's consent.
    const user = makeConfig({});
    const project = makeConfig({});

    const merged = mergeLayered(user, project);
    expect(merged.terminal?.enabled).toBeNull();
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

  test('mergeLayered(user, project) with project-local-scope field falls through to project', () => {
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });

    const merged = mergeLayered(user, project);
    expect(merged.autoSync?.enabled).toBe(true);
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
