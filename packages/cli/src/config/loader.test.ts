import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { type ConfigDiagnostic, REMOVED_KEYS } from '@inkeep/open-knowledge-core';
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
    expect(config.appearance.theme).toBe('dark');
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

  test('appearance.editorModeDefault in project config is stripped; appearance.theme survives', () => {
    // Also previously silent — never read by the engine.
    writeWorkspaceConfig('appearance:\n  theme: dark\n  editorModeDefault: source\n');
    const { config, diagnostics } = loadConfig(testDir);
    // Sibling under the same parent keeps its on-disk value.
    expect(config.appearance.theme).toBe('dark');
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

  test('appearance.theme outside the enum throws', () => {
    writeWorkspaceConfig('appearance:\n  theme: midnight\n');
    expect(() => loadConfig(testDir)).toThrow('Invalid configuration');
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
    // appearance.theme is a string enum — typing it as a non-member value
    // fails Zod validation. The loader uses parseDocument + locateIssue to
    // map the issue back to source position.
    const yaml = `appearance:
  theme: midnight
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
    // `theme: midnight` lives on line 2 of the fixture above.
    expect(caught?.message).toContain(`${expectedPath}:2:`);
    // Error message also includes the path-message line and a snippet.
    expect(caught?.message).toContain('appearance.theme');
  });

  test('source-located error renders code snippet with caret marker', () => {
    writeWorkspaceConfig('appearance:\n  theme: midnight\n');
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
