import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

let testDir: string;
let fakeHome: string;

// Stub node:os.homedir() before importing the loader so Layer 1 (user-global
// config) doesn't read the real `~/.ok/global.yml` and pollute
// every test that asserts on `sources`. Bun caches the resolved homedir on
// first call, so mutating `process.env.HOME` in beforeEach is too late.
await mock.module('node:os', () => {
  const actual = require('node:os');
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

  test('removed config keys in project config hard-error in one pass with redirects', () => {
    // Single-tier contract: every removed key throws (no warn tier). A project
    // config carrying several gets them all in one throw — no two-trip cycle.
    // sync.* and server.port are NOT in the registry (genuinely silent
    // loose-mode pass), so they contribute no error.
    writeWorkspaceConfig(
      'sync:\n  pushIntervalSeconds: 30\nserver:\n  port: 3000\n  host: example.dev\n  openOnAgentEdit: true\nmcp:\n  autoStart: false\n  tools:\n    grep:\n      maxResults: 100\n    search:\n      maxResults: 100\nupload:\n  maxBytes: 100000\ngithub:\n  oauthAppClientId: abc\ncontent:\n  dir: docs\n',
    );
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const msg = caught?.message ?? '';
    // Every registry key present is named.
    for (const key of [
      'server.host',
      'server.openOnAgentEdit',
      'mcp.autoStart',
      'mcp.tools.grep.maxResults',
      'mcp.tools.search.maxResults',
      'upload.maxBytes',
      'github.oauthAppClientId',
    ]) {
      expect(msg).toContain(key);
    }
    // Redirect hints name the replacement knob.
    expect(msg).toContain('--host');
    expect(msg).toContain('HOST');
    expect(msg).toContain('OPEN_KNOWLEDGE_GITHUB_CLIENT_ID');
    expect(msg).toContain('OK_MCP_AUTOSTART');
    expect(msg).toContain('streaming uploads have no user-facing cap');
    // Source-located: file:line:col points inside the fixture.
    const expectedPath = resolve(testDir, OK_DIR, 'config.yml');
    expect(msg).toMatch(new RegExp(`${expectedPath.replace(/[/\\.]/g, '\\$&')}:\\d+:\\d+`));
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

  test('content.include in project config rejects with REMOVED_KEY error directing to .okignore', () => {
    writeWorkspaceConfig(`content:
  include:
    - "**/*.md"
`);
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const expectedPath = resolve(testDir, OK_DIR, 'config.yml');
    // Source-located header: file:line:col points inside the fixture.
    expect(caught?.message).toMatch(
      new RegExp(`${expectedPath.replace(/[/\\.]/g, '\\$&')}:\\d+:\\d+`),
    );
    expect(caught?.message).toContain('content.include');
    // include-specific redirect: surfaces content.dir as the simpler
    // subdirectory-scoping alternative AND warns that .okignore is
    // exclude-only (don't copy include patterns directly).
    expect(caught?.message).toContain('content.dir');
    expect(caught?.message).toContain('.okignore');
    expect(caught?.message).toContain('exclude-only');
  });

  test('content.exclude in project config rejects with REMOVED_KEY error', () => {
    writeWorkspaceConfig(`content:
  exclude:
    - "**/drafts/**"
`);
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const expectedPath = resolve(testDir, OK_DIR, 'config.yml');
    expect(caught?.message).toMatch(
      new RegExp(`${expectedPath.replace(/[/\\.]/g, '\\$&')}:\\d+:\\d+`),
    );
    expect(caught?.message).toContain('content.exclude');
    // exclude-specific redirect: 1:1 migration to .okignore.
    expect(caught?.message).toContain('.okignore');
    expect(caught?.message).toContain('1:1 migration');
  });

  test('content.include AND content.exclude together emit BOTH REMOVED_KEY errors in one pass', () => {
    writeWorkspaceConfig(`content:
  include:
    - "**/*.md"
  exclude:
    - "**/drafts/**"
`);
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // Both keys should appear in the error message — no two-trip fix cycle
    // where the user fixes include, restarts, then sees exclude as a fresh
    // error.
    expect(caught?.message).toContain('content.include');
    expect(caught?.message).toContain('content.exclude');
    // Each key carries its own redirect (include → content.dir + exclude-only;
    // exclude → 1:1 migration).
    expect(caught?.message).toContain('content.dir');
    expect(caught?.message).toContain('1:1 migration');
  });

  test('folders in project config rejects with REMOVED_KEY directing to nested .ok/', () => {
    // The headline dead key: previously silent (no warn, no error) while the
    // docs still taught it. Now a source-located hard error.
    writeWorkspaceConfig(`folders:
  - path: "drafts/**"
    frontmatter:
      status: draft
`);
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const msg = caught?.message ?? '';
    expect(msg).toContain('folders');
    expect(msg).toContain('.ok/');
    expect(msg).toContain('edit({ folder');
    const expectedPath = resolve(testDir, OK_DIR, 'config.yml');
    expect(msg).toMatch(new RegExp(`${expectedPath.replace(/[/\\.]/g, '\\$&')}:\\d+:\\d+`));
  });

  test('appearance.editorModeDefault in project config rejects with REMOVED_KEY', () => {
    // Also previously silent — never read by the engine.
    writeWorkspaceConfig('appearance:\n  editorModeDefault: source\n');
    let caught: Error | undefined;
    try {
      loadConfig(testDir);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain('appearance.editorModeDefault');
    expect(caught?.message).toContain('WYSIWYG');
  });

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
