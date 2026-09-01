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
let fakeHome: string = resolve(tmpdir(), '__ok_home_default__');

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

function writeWorkspaceConfig(yaml: string) {
  const configDir = resolve(testDir, OK_DIR);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, 'config.yml'), yaml, 'utf-8');
}

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

function setPath(root: Record<string, unknown>, path: readonly string[], leaf: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = leaf;
}

function removedKeys(diagnostics: ConfigDiagnostic[]): Array<{ dotted: string; redirect: string }> {
  return diagnostics.flatMap((d) =>
    d.code === 'REMOVED_KEY' ? [{ dotted: d.path.join('.'), redirect: d.redirect }] : [],
  );
}

describe('loadConfig', () => {
  test('no config files → all defaults resolve', () => {
    const { config, sources } = loadConfig(testDir);

    expect(sources).toHaveLength(0);

    expect(config.content.dir).toBe('.');

    expect(config.appearance.theme).toBeUndefined();

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

    expect(sources).toHaveLength(0);
    expect(config.content.dir).toBe('.');
  });

  test('removed config keys in project config are stripped and reported; siblings survive', () => {
    writeWorkspaceConfig(
      'sync:\n  pushIntervalSeconds: 30\nserver:\n  port: 3000\n  host: example.dev\n  openOnAgentEdit: true\nmcp:\n  autoStart: false\n  tools:\n    grep:\n      maxResults: 100\n    search:\n      maxResults: 100\nupload:\n  maxBytes: 100000\ngithub:\n  oauthAppClientId: abc\ncontent:\n  dir: docs\n',
    );
    const { config, diagnostics } = loadConfig(testDir);
    expect(config.content.dir).toBe('docs');
    const removed = removedKeys(diagnostics);
    const dotted = removed.map((r) => r.dotted);
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
    const joined = removed.map((r) => r.redirect).join('\n');
    expect(joined).toContain('--bind');
    expect(joined).toContain('HOST');
    expect(joined).toContain('OPEN_KNOWLEDGE_GITHUB_CLIENT_ID');
    expect(joined).toContain('OK_MCP_AUTOSTART');
    expect(joined).toContain('streaming uploads have no user-facing cap');
    const expectedPath = resolve(testDir, OK_DIR, 'config.yml');
    for (const d of diagnostics) {
      if (d.code === 'REMOVED_KEY') {
        expect(d.source?.file).toBe(expectedPath);
        expect(d.source?.line ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test('project config overrides a single field, other defaults preserved', () => {
    writeWorkspaceConfig('content:\n  dir: docs\n');

    const { config, sources } = loadConfig(testDir);

    expect(sources).toHaveLength(1);
    expect(config.content.dir).toBe('docs');
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
    expect(config.appearance.theme).toBeUndefined();
  });

  test('content.include in project config is stripped with .okignore redirect; content.dir survives', () => {
    writeWorkspaceConfig(`content:
  dir: docs
  include:
    - "**/*.md"
`);
    const { config, diagnostics } = loadConfig(testDir);
    expect(config.content.dir).toBe('docs');
    const include = removedKeys(diagnostics).find((r) => r.dotted === 'content.include');
    expect(include).toBeDefined();
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
    expect(dotted).toContain('content.include');
    expect(dotted).toContain('content.exclude');
    const joined = removedKeys(diagnostics)
      .map((r) => r.redirect)
      .join('\n');
    expect(joined).toContain('content.dir');
    expect(joined).toContain('1:1 migration');
  });

  test('folders in project config is stripped with a nested .ok/ redirect', () => {
    writeWorkspaceConfig(`content:
  dir: docs
folders:
  - path: "drafts/**"
    frontmatter:
      status: draft
`);
    const { config, diagnostics } = loadConfig(testDir);
    expect(config.content.dir).toBe('docs');
    const folders = removedKeys(diagnostics).find((r) => r.dotted === 'folders');
    expect(folders).toBeDefined();
    expect(folders?.redirect).toContain('.ok/');
    expect(folders?.redirect).toContain('edit({ folder');
  });

  test('appearance.editorModeDefault in project config is stripped; sibling parses', () => {
    writeWorkspaceConfig('appearance:\n  theme: dark\n  editorModeDefault: source\n');
    const { config, diagnostics } = loadConfig(testDir);
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

  for (const entry of REMOVED_KEYS) {
    const dotted = entry.path.join('.');
    test(`committed config with ${dotted} loads; sibling preserved; one diagnostic`, () => {
      const obj: Record<string, unknown> = { content: { dir: 'docs' } };
      setPath(obj, entry.path, 'sentinel');
      writeWorkspaceConfig(stringify(obj));

      const { config, diagnostics } = loadConfig(testDir);

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

  test('an invalid project-scoped value throws', () => {
    writeWorkspaceConfig('server:\n  port: 99999999\n');
    expect(() => loadConfig(testDir)).toThrow('Invalid configuration');
  });

  test('a mis-scoped user-scoped value in the project file is ignored, not thrown', () => {
    writeWorkspaceConfig('appearance:\n  theme: midnight\n');
    expect(() => loadConfig(testDir)).not.toThrow();
    expect(loadConfig(testDir).config.appearance.theme).toBeUndefined();
  });

  test('unknown top-level keys are silently ignored (forward-compat)', () => {
    writeWorkspaceConfig('future_feature:\n  enabled: true\n');
    const { config } = loadConfig(testDir);

    expect(config.content.dir).toBe('.');
  });

  test('unknown nested keys within known sections are silently ignored', () => {
    writeWorkspaceConfig('content:\n  dir: docs\n  unknownKey: hello\n');
    const { config } = loadConfig(testDir);

    expect(config.content.dir).toBe('docs');
  });

  test('malformed YAML does not crash — returns defaults', () => {
    writeWorkspaceConfig('content:\n  dir: [invalid yaml');
    const { config } = loadConfig(testDir);
    expect(config.content.dir).toBe('.');
  });

  test('schema-invalid project config emits file:line:col in error message', () => {
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
    expect(caught?.message).toContain(`${expectedPath}:2:`);
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
    expect(caught?.message).toContain('^');
  });

  test('user-global config is sidelined on schema-invalid (cold-start recovery)', () => {
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
    writeWorkspaceConfig('server:\n  allowExternal: true\n');
    const { config } = loadConfig(testDir);
    expect(config.server.allowExternal).toBe(false);
  });

  test('committed openBrowser / idleShutdown (project-local, no schema default) are also inert', () => {
    writeWorkspaceConfig('server:\n  openBrowser: true\n  idleShutdown: off\n');
    const { config } = loadConfig(testDir);
    expect(config.server.openBrowser).toBeUndefined();
    expect(config.server.idleShutdown).toBeUndefined();
  });

  test('an explicit user-global value survives an empty project file (precedence, not clobber)', () => {
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
    expect(config.server.port).toBe(8080);
    expect(config.server.openBrowser).toBe(false);
  });

  test('project layer still owns project-scoped server keys (port, externalUrl)', () => {
    writeWorkspaceConfig('server:\n  port: 8080\n  externalUrl: https://kb.example.com\n');
    const { config } = loadConfig(testDir);
    expect(config.server.port).toBe(8080);
    expect(config.server.externalUrl).toBe('https://kb.example.com');
  });

  test('a committed server.bind is ignored (clone-safety) and reported as an ignored committed key', () => {
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
    writeWorkspaceConfig('server:\n  bind:\n    - 0.0.0.0\n');
    const { config } = loadConfig(testDir);

    const committedRuntime = resolveServerRuntimeConfig(config);
    expect(committedRuntime.bind).toEqual(['127.0.0.1']);
    expect(committedRuntime.loopbackOnly).toBe(true);
    expect(requiresExternalConsent(committedRuntime)).toBe(false);

    const envLayer = resolveEnvConfigLayer({ OK_BIND: '0.0.0.0' });
    const envConfig = applyConfigOverlay(config, envLayer.layer) as typeof config;
    const envRuntime = resolveServerRuntimeConfig(envConfig);
    expect(envRuntime.bind).toEqual(['0.0.0.0']);
    expect(envRuntime.loopbackOnly).toBe(false);
    expect(envRuntime.allowExternal).toBe(false);
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
