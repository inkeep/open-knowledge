import { describe, expect, test } from 'vitest';
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

  test("scope: 'user' (appearance.language) ignores a project-layer language entirely", () => {
    // The interface language is a personal preference; a repository must not
    // be able to decide what language its collaborators read the chrome in.
    // This also pins the leaf's registration landing on the enum rather than
    // on the `.optional()` wrapper — an unregistered leaf has no scope, so it
    // would silently fall through to default precedence and the project value
    // below would win.
    const user = makeConfig({ appearance: {} });
    const project = makeConfig({ appearance: { language: 'es' } });
    const projectLocal = makeConfig({ appearance: { language: 'zh-Hans' } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.appearance?.language).toBeUndefined();
  });

  test("scope: 'user' (appearance.language) keeps the 'system' sentinel the user stored", () => {
    // A concrete language in a lower layer must not overwrite 'system' —
    // that would convert a preference that follows the OS into a frozen one.
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

  test("scope: 'project-local' with null local no longer inherits the committed project value", () => {
    // POSTURE FLIP (project-local skips the committed layer): a project-local
    // leaf cleared to `null` on this machine falls through to USER, then the
    // schema default (autoSync.enabled → null) — NEVER the committed project
    // value. A per-machine key must not inherit a cloned value, null or absent.
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
    // POSTURE FLIP: an unset project-local leaf skips the committed project
    // layer and resolves to the schema default (null), not the committed value.
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

  test("scope: 'project-local' (server.bind) ignores a committed project value; the project-local layer wins", () => {
    // server.bind is per-machine: a committed bind (one machine exposing the
    // server) must never reach a teammate's local run — only this machine's
    // gitignored project-local layer sets it. Same posture as allowExternal.
    const user = makeConfig({});
    const project = makeConfig({ server: { bind: ['0.0.0.0'] } });
    const projectLocal = makeConfig({ server: { bind: ['192.168.1.5'] } });

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.server?.bind).toEqual(['192.168.1.5']);
  });

  test('a clone with a committed non-loopback bind but no project-local layer falls to the loopback default', () => {
    // The exact footgun: a repo commits `server.bind: [0.0.0.0]` so one box
    // serves remotely; every teammate who clones and runs locally must still
    // bind loopback (and boot), never inherit the committed non-loopback value
    // (which would trip the exposure interlock they never consented to).
    const user = makeConfig({});
    const project = makeConfig({ server: { bind: ['0.0.0.0'] } });
    const projectLocal = makeConfig({});

    const merged = mergeLayered(user, project, projectLocal);
    expect(merged.server?.bind).toEqual(['127.0.0.1']);
  });

  test('RAW-layer path: a committed bind is skipped; a user-global bind is honored as a personal default', () => {
    // The loader's inputs are RAW (un-parsed) partials. A committed project
    // `bind` surfaces no `bind` from the merge (→ the final parse fills the
    // loopback default), while a user-global bind still wins as a cross-project
    // personal default (the project-local fallback is user, never project).
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
    // Exposure consent has the terminal.enabled posture: a committed
    // `allowExternal: true` must never grant consent on a cloner's machine —
    // only this machine's gitignored project-local layer can. The project-local
    // scope rule skips the committed project layer structurally, so the leaf
    // resolves through user to the schema default `false` (here the parsed
    // layers make user's default a defined `false`; on the loader's raw path an
    // unset leaf reaches the same default at the final parse).
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
    // POSTURE FLIP: the two-layer path also skips the committed project layer
    // for project-local leaves, so a committed value never wins — it falls to
    // user, then the schema default (null).
    const user = makeConfig({});
    const project = makeConfig({ autoSync: { enabled: true } });

    const merged = mergeLayered(user, project);
    expect(merged.autoSync?.enabled).toBeNull();
  });

  test('a committed allowExternal:true never passes through, even via the two-layer merge', () => {
    // POSTURE FLIP of the former "two-layer is unsafe" tripwire. The
    // project-local scope rule now skips the committed project layer
    // unconditionally, so a committed `server.allowExternal: true` can never
    // arm consent — with or without a project-local layer. The old safety
    // depended on a parsed project-local layer supplying a DEFINED `false`;
    // the structural skip replaces it and also holds on the RAW-layer path the
    // loader uses (an unset local leaf is `undefined` → falls to the user
    // layer's default `false`).
    const user = makeConfig({});
    const project = makeConfig({ server: { allowExternal: true } });

    const merged = mergeLayered(user, project);
    expect(merged.server?.allowExternal).toBe(false);
  });

  test('RAW-layer path: a committed allowExternal is skipped, an unset local leaf falls to the schema default', () => {
    // The loader's actual inputs are RAW (un-parsed) partials, not
    // ConfigSchema.parse output. Pin that on that path a committed project
    // `allowExternal: true` with an empty project-local layer surfaces no
    // `allowExternal` from the merge (→ the final parse fills the default
    // false), while a user-global value is still honored as a personal default.
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
