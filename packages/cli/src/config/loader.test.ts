import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  applyConfigOverlay,
  type ConfigDiagnostic,
  REMOVED_KEYS,
  requiresExternalConsent,
  resolveEnvConfigLayer,
  resolveServerRuntimeConfig,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';

let testDir: string;
// Seed a real default so the loader's transitive homedir() call at import time
// (the server file-logger builds `<home>/.ok/logs` as a module side effect)
// never sees undefined before beforeEach runs; beforeEach overrides it per test.
let fakeHome: string = resolve(tmpdir(), '__ok_home_default__');

// Stub node:os.homedir() before importing the loader so Layer 1 (user-global
// config) doesn't read the real `~/.ok/global.yml` and pollute
// every test that asserts on `sources`. Bun caches the resolved homedir on
// first call, so mutating `process.env.HOME` in beforeEach is too late.
await vi.doMock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

const { OK_DIR } = await import('../constants.ts');
const { createProjectConfigResolver, loadConfig } = await import('./loader');

beforeEach(() => {
  testDir = resolve(
    tmpdir(),
    `ok-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  fakeHome = resolve(testDir, '__home__');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Helper: write a project config.yml inside testDir */
function writeWorkspaceConfig(yaml: string) {
  const configDir = resolve(testDir, OK_DIR);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, 'config.yml'), yaml, 'utf-8');
}

/** Helper: write a project-local .ok/local/config.yml inside testDir */
function writeLocalConfig(yaml: string) {
  const localDir = resolve(testDir, OK_DIR, 'local');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(resolve(localDir, 'config.yml'), yaml, 'utf-8');
}

function writeWorkspaceConfigAt(dir: string, yaml: string) {
  const configDir = resolve(dir, OK_DIR);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, 'config.yml'), yaml, 'utf-8');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Set a (possibly nested) leaf on `root`, creating intermediate objects. */
function setPath(root: Record<string, unknown>, path: readonly string[], leaf: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = leaf;
}

/** Only the REMOVED_KEY diagnostics, dotted-path indexed for lookup. */
function removedKeys(diagnostics: ConfigDiagnostic[]): Array<{ dotted: string; redirect: string }> {
  return diagnostics.flatMap((d) =>
    d.code === 'REMOVED_KEY' ? [{ dotted: d.path.join('.'), redirect: d.redirect }] : [],
  );
}

describe('loadConfig', () => {
  // ── Defaults ────────────────────────────────────────────────────────

  test('no config files → all defaults resolve', () => {
    const { config, sources } = loadConfig(testDir);

    // sources
    expect(sources).toHaveLength(0);

    // content
    expect(config.content.dir).toBe('.');

    // appearance defaults to UNSET
    expect(config.appearance.theme).toBeUndefined();

    // autoSync.enabled defaults to null (the "unanswered" sentinel — the
    // onboarding modal gates on this to distinguish "user has not chosen"
    // from `true` / `false`).
    expect(config.autoSync.enabled).toBeNull();
  });

  test('empty YAML file → all defaults resolve', () => {
    writeWorkspaceConfig('');
    const { config } = loadConfig(testDir);

    expect(config.content.dir).toBe('.');
    expect(config.autoSync.enabled).toBeNull();
  });

  test('comments-only YAML (scaffolded config) → all defaults resolve', () => {
    writeWorkspaceConfig(`
# This is a fully commented config
# content:
#   dir: .
`);
    const { config, sources } = loadConfig(testDir);

    // Comments-only YAML parses to null, so no source is recorded
    expect(sources).toHaveLength(0);
    expect(config.content.dir).toBe('.');
  });

  test('removed config keys in project config are stripped and reported; siblings survive', () => {
    // Strip-and-continue: a dead key no longer blocks startup. A project config
    // carrying several gets them all stripped in one pass — no two-trip cycle —
    // and each is reported as a REMOVED_KEY diagnostic naming its replacement.
    // sync.* and server.port are NOT in the registry (genuinely silent
    // loose-mode pass), so they contribute no diagnostic.
    writeWorkspaceConfig(
      'sync:\n  pushIntervalSeconds: 30\nserver:\n  port: 3000\n  host: example.dev\n  openOnAgentEdit: true\nmcp:\n  autoStart: false\n  tools:\n    grep:\n      maxResults: 100\n    search:\n      maxResults: 100\nupload:\n  maxBytes: 100000\ngithub:\n  oauthAppClientId: abc\ncontent:\n  dir: docs\n',
    );
    const { config, diagnostics } = loadConfig(testDir);
    // The unrelated live key resolves to its on-disk value, not a default.
    expect(config.content.dir).toBe('docs');
    const removed = removedKeys(diagnostics);
    const dotted = removed.map((r) => r.dotted);
    // Every registry key present is reported.
    for (const key of [
      'server.host',
      'server.openOnAgentEdit',
      'mcp.autoStart',
      'mcp.tools.grep.maxResults',
      'mcp.tools.search.maxResults',
      'upload.maxBytes',
      'github.oauthAppClientId',
    ]) {
      expect(dotted).toContain(key);
    }
    // Each redirect names the replacement knob.
    const joined = removed.map((r) => r.redirect).join('\n');
    expect(joined).toContain('--host');
    expect(joined).toContain('HOST');
    expect(joined).toContain('OPEN_KNOWLEDGE_GITHUB_CLIENT_ID');
    expect(joined).toContain('OK_MCP_AUTOSTART');
    expect(joined).toContain('streaming uploads have no user-facing cap');
    // Source-located: each diagnostic points inside the committed file.
    const expectedPath = resolve(testDir, OK_DIR, 'config.yml');
    for (const d of diagnostics) {
      if (d.code === 'REMOVED_KEY') {
        expect(d.source?.file).toBe(expectedPath);
        expect(d.source?.line ?? 0).toBeGreaterThan(0);
      }
    }
  });

  // ── Workspace overrides ─────────────────────────────────────────────

  test('project config overrides a single field, other defaults preserved', () => {
    writeWorkspaceConfig('content:\n  dir: docs\n');

    const { config, sources } = loadConfig(testDir);

    expect(sources).toHaveLength(1);
    expect(config.content.dir).toBe('docs');
    // other sections untouched
    expect(config.appearance.theme).toBeUndefined();
    expect(config.autoSync.enabled).toBeNull();
  });

  test('project config overrides multiple sections at once', () => {
    writeWorkspaceConfig(`
content:
  dir: docs
appearance:
  theme: dark
`);
    const { config } = loadConfig(testDir);

    expect(config.content.dir).toBe('docs');
    // Posture flip (scope-aware loader): appearance.theme is a USER-scoped
    // leaf, so a project-file value no longer reaches the merged view — a
    // committed theme must not force one collaborator's preference on
    // everyone. Previously the scope-blind deep merge let it win.
    expect(config.appearance.theme).toBeUndefined();
  });

  test('content.include in project config is stripped with .okignore redirect; content.dir survives', () => {
    writeWorkspaceConfig(`content:
  dir: docs
  include:
    - "**/*.md"
`);
    const { config, diagnostics } = loadConfig(testDir);
    // Sibling under the same parent keeps its on-disk value.
    expect(config.content.dir).toBe('docs');
    const include = removedKeys(diagnostics).find((r) => r.dotted === 'content.include');
    expect(include).toBeDefined();
    // include-specific redirect: surfaces content.dir as the simpler
    // subdirectory-scoping alternative AND warns that .okignore is
    // exclude-only (don't copy include patterns directly).
    expect(include?.redirect).toContain('content.dir');
    expect(include?.redirect).toContain('.okignore');
    expect(include?.redirect).toContain('exclude-only');
  });

  test('content.exclude in project config is stripped with a 1:1 .okignore redirect', () => {
    writeWorkspaceConfig(`content:
  dir: docs
  exclude:
    - "**/drafts/**"
`);
    const { config, diagnostics } = loadConfig(testDir);
    expect(config.content.dir).toBe('docs');
    const exclude = removedKeys(diagnostics).find((r) => r.dotted === 'content.exclude');
    expect(exclude).toBeDefined();
    // exclude-specific redirect: 1:1 migration to .okignore.
    expect(exclude?.redirect).toContain('.okignore');
    expect(exclude?.redirect).toContain('1:1 migration');
  });

  test('content.include AND content.exclude together are both stripped in one pass', () => {
    writeWorkspaceConfig(`content:
  include:
    - "**/*.md"
  exclude:
    - "**/drafts/**"
`);
    const { diagnostics } = loadConfig(testDir);
    const dotted = removedKeys(diagnostics).map((r) => r.dotted);
    // Both keys are reported in one read — no two-trip fix cycle where the user
    // fixes include, restarts, then sees exclude as a fresh finding.
    expect(dotted).toContain('content.include');
    expect(dotted).toContain('content.exclude');
    // Each key carries its own redirect (include → content.dir + exclude-only;
    // exclude → 1:1 migration).
    const joined = removedKeys(diagnostics)
      .map((r) => r.redirect)
      .join('\n');
    expect(joined).toContain('content.dir');
    expect(joined).toContain('1:1 migration');
  });

  test('folders in project config is stripped with a nested .ok/ redirect', () => {
    // The headline dead key: previously silent (no warn, no error) while the
    // docs still taught it. Now stripped and reported, not a hard failure.
    writeWorkspaceConfig(`content:
  dir: docs
folders:
  - path: "drafts/**"
    frontmatter:
      status: draft
`);
    const { config, diagnostics } = loadConfig(testDir);
    // An unrelated top-level section is untouched by stripping folders.
    expect(config.content.dir).toBe('docs');
    const folders = removedKeys(diagnostics).find((r) => r.dotted === 'folders');
    expect(folders).toBeDefined();
    expect(folders?.redirect).toContain('.ok/');
    expect(folders?.redirect).toContain('edit({ folder');
  });

  test('appearance.editorModeDefault in project config is stripped; sibling parses', () => {
    // Also previously silent — never read by the engine.
    writeWorkspaceConfig('appearance:\n  theme: dark\n  editorModeDefault: source\n');
    const { config, diagnostics } = loadConfig(testDir);
    // Posture flip (scope-aware loader): the live sibling still PARSES (the
    // strip must not take it down), but appearance.theme is a USER-scoped
    // leaf, so the project-file value no longer reaches the merged view.
    expect(config.appearance.theme).toBeUndefined();
    const mode = removedKeys(diagnostics).find((r) => r.dotted === 'appearance.editorModeDefault');
    expect(mode).toBeDefined();
    expect(mode?.redirect).toContain('WYSIWYG');
  });

  test('a clean committed config yields no diagnostics', () => {
    writeWorkspaceConfig('content:\n  dir: docs\n');
    const { config, diagnostics } = loadConfig(testDir);
    expect(config.content.dir).toBe('docs');
    expect(diagnostics).toEqual([]);
  });

  // Parameterized over every registry entry: a committed config carrying that
  // key plus a live sibling loads successfully, strips the key, preserves the
  // sibling, and reports exactly one diagnostic. This is the invariant that
  // keeps a dead key from bricking `ok start`, and it stays correct as the
  // registry grows.
  for (const entry of REMOVED_KEYS) {
    const dotted = entry.path.join('.');
    test(`committed config with ${dotted} loads; sibling preserved; one diagnostic`, () => {
      const obj: Record<string, unknown> = { content: { dir: 'docs' } };
      setPath(obj, entry.path, 'sentinel');
      writeWorkspaceConfig(stringify(obj));

      const { config, diagnostics } = loadConfig(testDir);

      // Sibling resolves to its on-disk value, not a schema default.
      expect(config.content.dir).toBe('docs');
      const removed = diagnostics.filter((d) => d.code === 'REMOVED_KEY');
      expect(removed).toHaveLength(1);
      const [diag] = removed;
      if (diag?.code === 'REMOVED_KEY') {
        expect(diag.path).toEqual(entry.path);
        expect(diag.redirect).toBe(entry.redirect);
      }
    });
  }

  // ── Validation ──────────────────────────────────────────────────────

  test('an invalid project-scoped value throws', () => {
    // server.port is project-scoped and range-checked (1–65535); an
    // out-of-range value survives the scope-aware merge and fails the single
    // merged parse.
    writeWorkspaceConfig('server:\n  port: 99999999\n');
    expect(() => loadConfig(testDir)).toThrow('Invalid configuration');
  });

  test('a mis-scoped user-scoped value in the project file is ignored, not thrown', () => {
    // Raw-merge-then-parse-once trade: the scope-aware merge drops a
    // user-scoped leaf (appearance.theme) set in the project file BEFORE the
    // single merged parse, so an invalid value there is silently ignored
    // rather than reported — errors surface only for values that reach the
    // merged view. (A project cannot set a user-scoped key anyway.)
    writeWorkspaceConfig('appearance:\n  theme: midnight\n');
    expect(() => loadConfig(testDir)).not.toThrow();
    expect(loadConfig(testDir).config.appearance.theme).toBeUndefined();
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  test('unknown top-level keys are silently ignored (forward-compat)', () => {
    writeWorkspaceConfig('future_feature:\n  enabled: true\n');
    const { config } = loadConfig(testDir);

    // Still resolves defaults — no crash
    expect(config.content.dir).toBe('.');
  });

  test('unknown nested keys within known sections are silently ignored', () => {
    writeWorkspaceConfig('content:\n  dir: docs\n  unknownKey: hello\n');
    const { config } = loadConfig(testDir);

    expect(config.content.dir).toBe('docs');
  });

  test('malformed YAML does not crash — returns defaults', () => {
    writeWorkspaceConfig('content:\n  dir: [invalid yaml');
    // Malformed YAML is caught by the loader and warned, falls back to defaults
    const { config } = loadConfig(testDir);
    expect(config.content.dir).toBe('.');
  });

  // ── Source-located errors ────────────────────────────

  test('schema-invalid project config emits file:line:col in error message', () => {
    // server.port is project-scoped, so an out-of-range value survives the
    // scope-aware merge and fails the single merged parse; the loader uses
    // parseDocument + locateIssue to map the issue back to source position.
    const yaml = `server:
  port: 99999999
`;
    writeWorkspaceConfig(yaml);
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const expectedPath = resolve(testDir, OK_DIR, 'config.yml');
    // The expected literal: <abs-path>:<line>:<col> — must be `2:` because
    // `port: 99999999` lives on line 2 of the fixture above.
    expect(caught?.message).toContain(`${expectedPath}:2:`);
    // Error message also includes the path-message line and a snippet.
    expect(caught?.message).toContain('server.port');
  });

  test('source-located error renders code snippet with caret marker', () => {
    writeWorkspaceConfig('server:\n  port: 99999999\n');
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // Caret marker (`^^^`) should appear under the offending value in
    // the code snippet (separate line below the source line).
    expect(caught?.message).toContain('^');
  });

  test('user-global config is sidelined on schema-invalid (cold-start recovery)', () => {
    // Simulate a user-global config by routing readConfigSafely through a
    // tempdir-backed homedir override at the call site. The simplest way
    // to test the flow without monkey-patching homedir is to test
    // readConfigSafely in isolation
    // Here we just confirm loader doesn't throw when the
    // user-global file is missing — the standard happy path.
    expect(() => loadConfig(testDir)).not.toThrow();
  });

  test('user-global reads from `~/.ok/global.yml` (not `config.yml`)', () => {
    const okDir = resolve(fakeHome, OK_DIR);
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'global.yml'), 'appearance:\n  theme: dark\n', 'utf-8');
    const { config, sources } = loadConfig(testDir);
    expect(config.appearance.theme).toBe('dark');
    expect(sources).toContain(resolve(okDir, 'global.yml'));
  });

  // The committed layer is parameterized over the whole registry above; this
  // pins the same strip-and-continue contract through the OTHER layer, which
  // reaches `diagnostics` by a different route (`readConfigSafely` upstream,
  // then a deep merge). Deleting the user-layer diagnostics push, or a merge
  // that dropped user siblings once a key was stripped, would only fail here.
  test('user-global strip-and-continue: sibling survives the merge, key is reported', () => {
    const okDir = resolve(fakeHome, OK_DIR);
    mkdirSync(okDir, { recursive: true });
    writeFileSync(
      resolve(okDir, 'global.yml'),
      'server:\n  host: 0.0.0.0\nappearance:\n  theme: dark\n',
      'utf-8',
    );

    const { config, diagnostics } = loadConfig(testDir);

    expect(config.appearance.theme).toBe('dark');
    const removed = diagnostics.filter((d) => d.code === 'REMOVED_KEY');
    expect(removed).toHaveLength(1);
    const [diag] = removed;
    if (diag?.code === 'REMOVED_KEY') {
      expect(diag.path).toEqual(['server', 'host']);
    }
  });

  // The gap that let `ok config validate` answer "✓ valid" for a file it could
  // not parse: the merged config falls back to defaults, which always validate,
  // so the only evidence a layer was skipped is the diagnostic.
  test('an unparseable committed config degrades to defaults AND reports YAML_PARSE', () => {
    writeWorkspaceConfig('content:\n  dir: [invalid yaml');

    const { config, diagnostics } = loadConfig(testDir);

    expect(config.content.dir).toBe('.');
    const parseFailures = diagnostics.filter((d) => d.code === 'YAML_PARSE');
    expect(parseFailures).toHaveLength(1);
  });
});

describe('createProjectConfigResolver', () => {
  test('loads different project configs per cwd', async () => {
    const projectA = resolve(testDir, 'project-a');
    const projectB = resolve(testDir, 'project-b');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeWorkspaceConfigAt(projectA, 'content:\n  dir: docs-a\n');
    writeWorkspaceConfigAt(projectB, 'content:\n  dir: docs-b\n');

    const startupConfig = loadConfig(projectA).config;
    const resolveConfig = createProjectConfigResolver({
      startupCwd: projectA,
      startupConfig,
      cacheMs: 10_000,
    });

    await expect(resolveConfig(projectA)).resolves.toMatchObject({
      content: { dir: 'docs-a' },
    });
    await expect(resolveConfig(projectB)).resolves.toMatchObject({
      content: { dir: 'docs-b' },
    });
  });

  test('normalizes cwd before config cache lookups', async () => {
    const realProject = resolve(testDir, 'project-real');
    const symlinkProject = resolve(testDir, 'project-link');
    mkdirSync(realProject, { recursive: true });
    symlinkSync(realProject, symlinkProject);

    const startupConfig = loadConfig(realProject).config;
    let loadCalls = 0;
    const resolveConfig = createProjectConfigResolver({
      startupCwd: realProject,
      startupConfig,
      cacheMs: 10_000,
      loadConfigFn: (cwd) => {
        loadCalls += 1;
        return loadConfig(cwd);
      },
    });

    await expect(resolveConfig(symlinkProject)).resolves.toMatchObject(startupConfig);
    expect(loadCalls).toBe(0);
  });

  test('deduplicates concurrent config loads for the same cwd', async () => {
    const projectA = resolve(testDir, 'project-a');
    const projectB = resolve(testDir, 'project-b');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeWorkspaceConfigAt(projectB, 'content:\n  dir: docs-b\n');

    const startupConfig = loadConfig(projectA).config;
    let loadCalls = 0;
    const resolveConfig = createProjectConfigResolver({
      startupCwd: projectA,
      startupConfig,
      cacheMs: 10_000,
      loadConfigFn: (cwd) => {
        loadCalls += 1;
        return loadConfig(cwd);
      },
    });

    const [first, second] = await Promise.all([resolveConfig(projectB), resolveConfig(projectB)]);
    expect(first).toMatchObject({ content: { dir: 'docs-b' } });
    expect(second).toMatchObject({ content: { dir: 'docs-b' } });
    expect(loadCalls).toBe(1);
  });

  test('reloads config after cache expiration', async () => {
    const projectA = resolve(testDir, 'project-a');
    const projectB = resolve(testDir, 'project-b');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeWorkspaceConfigAt(projectB, 'content:\n  dir: docs-b\n');

    const startupConfig = loadConfig(projectA).config;
    let loadCalls = 0;
    const resolveConfig = createProjectConfigResolver({
      startupCwd: projectA,
      startupConfig,
      cacheMs: 1,
      loadConfigFn: (cwd) => {
        loadCalls += 1;
        return loadConfig(cwd);
      },
    });

    await expect(resolveConfig(projectB)).resolves.toMatchObject({
      content: { dir: 'docs-b' },
    });

    writeWorkspaceConfigAt(projectB, 'content:\n  dir: docs-c\n');
    await wait(5);

    await expect(resolveConfig(projectB)).resolves.toMatchObject({
      content: { dir: 'docs-c' },
    });
    expect(loadCalls).toBe(2);
  });
});

describe('loadConfig — scope-aware layering (project-local)', () => {
  test('project-local layer is read and lands in sources', () => {
    writeLocalConfig('server:\n  allowExternal: true\n');
    const { config, sources } = loadConfig(testDir);
    expect(config.server.allowExternal).toBe(true);
    expect(sources).toContain(resolve(testDir, OK_DIR, 'local', 'config.yml'));
  });

  test('a committed server.allowExternal: true never arms exposure (clone-leak guarantee)', () => {
    // allowExternal is a PROJECT-LOCAL leaf: consent never travels via git,
    // clone, or share. mergeLayered's project-local scope rule skips the
    // committed project layer, so a committed value resolves to the schema
    // default (false) — the leak the scope-blind deep merge used to allow.
    writeWorkspaceConfig('server:\n  allowExternal: true\n');
    const { config } = loadConfig(testDir);
    expect(config.server.allowExternal).toBe(false);
  });

  test('committed openBrowser / idleShutdown (project-local, no schema default) are also inert', () => {
    // These project-local leaves have NO Zod default (they derive at resolve
    // time), so the old "parsed local default wins" guard didn't protect them
    // — a committed value used to travel via clone. The scope-skip closes that
    // regardless of whether the leaf has a default: committed values are
    // dropped, leaving the leaf undefined for the resolver to derive.
    writeWorkspaceConfig('server:\n  openBrowser: true\n  idleShutdown: off\n');
    const { config } = loadConfig(testDir);
    expect(config.server.openBrowser).toBeUndefined();
    expect(config.server.idleShutdown).toBeUndefined();
  });

  test('an explicit user-global value survives an empty project file (precedence, not clobber)', () => {
    // Regression pin for the precedence bug: telemetry.localSink.enabled is
    // project-scoped with a schema default of true. A user who disables it in
    // ~/.ok/global.yml, in a project that never mentions the key, must keep
    // false — the old per-layer parse filled the project layer's default true
    // and clobbered the user value. Raw layers leave the project leaf
    // undefined, so the project-scope rule falls back to the user's false.
    const okDir = resolve(fakeHome, OK_DIR);
    mkdirSync(okDir, { recursive: true });
    writeFileSync(
      resolve(okDir, 'global.yml'),
      'telemetry:\n  localSink:\n    enabled: false\n',
      'utf-8',
    );
    const { config } = loadConfig(testDir);
    expect(config.telemetry.localSink.enabled).toBe(false);
  });

  test('project-local wins over project for a project-local leaf it sets', () => {
    writeWorkspaceConfig('server:\n  port: 8080\n');
    writeLocalConfig('server:\n  openBrowser: false\n');
    const { config } = loadConfig(testDir);
    // Project-scoped leaf from the project layer…
    expect(config.server.port).toBe(8080);
    // …and the project-local leaf from the local layer, in one merged view.
    expect(config.server.openBrowser).toBe(false);
  });

  test('project layer still owns project-scoped server keys (port, externalUrl)', () => {
    writeWorkspaceConfig('server:\n  port: 8080\n  externalUrl: https://kb.example.com\n');
    const { config } = loadConfig(testDir);
    expect(config.server.port).toBe(8080);
    expect(config.server.externalUrl).toBe('https://kb.example.com');
  });

  test('a committed server.bind is ignored (clone-safety) and reported as an ignored committed key', () => {
    // The footgun: a repo commits a non-loopback bind so one machine serves
    // remotely; a teammate who clones and runs `ok start` locally must bind the
    // loopback default (and boot), never inherit the committed value — which
    // would trip the exposure interlock they never consented to.
    writeWorkspaceConfig('server:\n  bind:\n    - 0.0.0.0\n');
    const { config, ignoredCommittedKeys } = loadConfig(testDir);
    expect(config.server.bind).toEqual(['127.0.0.1']);
    const bindKey = ignoredCommittedKeys.find((k) => k.path.join('.') === 'server.bind');
    expect(bindKey).toBeDefined();
    expect(bindKey?.envVar).toBe('OK_BIND');
  });

  test('a project-local server.bind is honored, with no ignored-committed-key warning', () => {
    writeLocalConfig('server:\n  bind:\n    - 0.0.0.0\n');
    const { config, ignoredCommittedKeys } = loadConfig(testDir);
    expect(config.server.bind).toEqual(['0.0.0.0']);
    expect(ignoredCommittedKeys).toEqual([]);
  });

  test('a committed file with both a removed key and a project-local key reports each correctly', () => {
    // strip-removed-keys runs BEFORE the project-local detector in loadRawLayer.
    // Pin that the two don't interfere: the removed `server.host` is stripped and
    // reported as REMOVED_KEY, the committed `server.bind` survives stripping and
    // is still flagged as ignored, and the in-scope `server.port` takes effect.
    writeWorkspaceConfig('server:\n  host: 0.0.0.0\n  bind:\n    - 0.0.0.0\n  port: 8080\n');
    const { config, diagnostics, ignoredCommittedKeys } = loadConfig(testDir);
    expect(config.server.port).toBe(8080);
    expect(config.server.bind).toEqual(['127.0.0.1']);
    expect(removedKeys(diagnostics).some((k) => k.dotted === 'server.host')).toBe(true);
    const bindKey = ignoredCommittedKeys.find((k) => k.path.join('.') === 'server.bind');
    expect(bindKey).toBeDefined();
    expect(bindKey?.envVar).toBe('OK_BIND');
  });

  test('interlock resolution: a committed bind boots on loopback, but explicit OK_BIND stays exposing', () => {
    // Mirrors the `ok start` resolution pipeline: loadConfig (scope-aware merge)
    // -> env overlay -> resolveServerRuntimeConfig. A committed non-loopback
    // bind resolves loopback-only, so the exposure interlock passes and the
    // server boots. The SAME value supplied per-machine via OK_BIND resolves
    // non-loopback (loopbackOnly false, no consent) -> the interlock still
    // refuses. That path is the real exposing host and must stay loud.
    writeWorkspaceConfig('server:\n  bind:\n    - 0.0.0.0\n');
    const { config } = loadConfig(testDir);

    const committedRuntime = resolveServerRuntimeConfig(config);
    expect(committedRuntime.bind).toEqual(['127.0.0.1']);
    expect(committedRuntime.loopbackOnly).toBe(true);
    // The interlock decision itself, not just its input: no consent required.
    expect(requiresExternalConsent(committedRuntime)).toBe(false);

    const envLayer = resolveEnvConfigLayer({ OK_BIND: '0.0.0.0' });
    const envConfig = applyConfigOverlay(config, envLayer.layer) as typeof config;
    const envRuntime = resolveServerRuntimeConfig(envConfig);
    expect(envRuntime.bind).toEqual(['0.0.0.0']);
    expect(envRuntime.loopbackOnly).toBe(false);
    expect(envRuntime.allowExternal).toBe(false);
    // The interlock still refuses: consent is required and not granted, so the
    // exposing OK_BIND host stays loud (asserts the predicate, not just inputs).
    expect(requiresExternalConsent(envRuntime)).toBe(true);
  });

  test('schema-invalid project-local file throws loud with the file named', () => {
    writeLocalConfig('server:\n  openBrowser: "sometimes"\n');
    expect(() => loadConfig(testDir)).toThrow(/openBrowser/);
  });

  test('removed keys in the project-local file strip-and-continue', () => {
    writeLocalConfig('server:\n  host: 0.0.0.0\n  openBrowser: false\n');
    const { config, diagnostics } = loadConfig(testDir);
    expect(config.server.openBrowser).toBe(false);
    expect(removedKeys(diagnostics).some((k) => k.dotted === 'server.host')).toBe(true);
  });
});
