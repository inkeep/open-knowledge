import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOVED_KEYS } from '@inkeep/open-knowledge-core';
import { CONFIG_FILENAME, OK_DIR } from '../constants.ts';
import { buildClearPatchForTest, DROPPED_FIELD_PATHS, runMigrate, runValidate } from './config.ts';

// Re-exported via the test module helper at the bottom of this file. The
// `buildClearPatch` helper isn't exported by config.ts directly (kept private
// to discourage external use), so the test module re-exports it for coverage.

function makeTempProject(): { cwd: string; userHome: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ok-config-test-'));
  const cwd = join(root, 'project');
  const userHome = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  return {
    cwd,
    userHome,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function projectConfigPath(cwd: string): string {
  return join(cwd, OK_DIR, CONFIG_FILENAME);
}

function userConfigPath(home: string): string {
  // User-global config lives at `~/.ok/global.yml` (distinct from project
  // `.ok/config.yml`); see `resolveConfigPath('user', …)` in core.
  return join(home, OK_DIR, 'global.yml');
}

function writeConfigYaml(absPath: string, content: string): void {
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content, { encoding: 'utf-8' });
}

describe('runValidate', () => {
  test('success → ok:true and ✓ message to stderr; nothing to stdout', () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const outcome = runValidate({
      loadConfigFn: () =>
        ({
          config: {} as never,
          sources: ['/home/test/project/.ok/config.yml'],
        }) as never,
      log: (msg) => stderr.push(msg),
      error: (msg) => stderr.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stderr.some((m) => m.includes('✓ Configuration valid'))).toBe(true);
    expect(stderr.some((m) => m.includes('/home/test/project/.ok/config.yml'))).toBe(true);
    expect(stdout).toEqual([]);
  });

  test('no sources → "defaults only"', () => {
    const stderr: string[] = [];
    const outcome = runValidate({
      loadConfigFn: () => ({ config: {} as never, sources: [] }) as never,
      log: (msg) => stderr.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stderr.some((m) => m.includes('defaults only'))).toBe(true);
  });

  test('schema-fail → ok:false and stderr contains the thrown error message', () => {
    const stderr: string[] = [];
    const outcome = runValidate({
      loadConfigFn: () => {
        throw new Error('Invalid configuration at /tmp/.ok/config.yml:7:18\n  ...');
      },
      error: (msg) => stderr.push(msg),
    });
    expect(outcome.ok).toBe(false);
    expect(stderr.some((m) => m.includes('Invalid configuration'))).toBe(true);
    expect(stderr.some((m) => m.includes(':7:18'))).toBe(true);
  });

  test('source-located error rendering through real loadConfig', () => {
    const project = makeTempProject();
    try {
      const wsPath = projectConfigPath(project.cwd);
      writeConfigYaml(wsPath, `appearance:\n  theme: midnight\n`);
      const stderr: string[] = [];
      const outcome = runValidate({
        cwd: project.cwd,
        error: (msg) => stderr.push(msg),
      });
      expect(outcome.ok).toBe(false);
      // file:line:col substring
      const joined = stderr.join('\n');
      expect(joined).toContain(`${wsPath}:`);
      // Snippet caret marker
      expect(joined).toContain('^');
    } finally {
      project.cleanup();
    }
  });
});

describe('runMigrate', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  test('no files → "No deprecated fields found." and ok:true', async () => {
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stdout).toEqual(['No deprecated fields found.']);
    expect(outcome.outcomes.every((o) => o.found.length === 0)).toBe(true);
  });

  test('clean project + missing user → no-op summary', async () => {
    writeConfigYaml(projectConfigPath(project.cwd), 'content:\n  dir: docs\n');
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stdout).toEqual(['No deprecated fields found.']);
  });

  test('removes sync.* + preserves comments and unrelated fields (project)', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const original = `# Header comment\n\n# --- content ---\ncontent:\n  dir: docs\n\n# Should be migrated away\nsync:\n  pushIntervalSeconds: 30\n  enabled: true\n\n# Trailing comment\n`;
    writeConfigYaml(wsPath, original);
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    const migrated = readFileSync(wsPath, 'utf-8');
    expect(migrated).not.toContain('sync:');
    expect(migrated).not.toContain('pushIntervalSeconds');
    expect(migrated).toContain('content:');
    expect(migrated).toContain('dir: docs');
    // Comments preserved
    expect(migrated).toContain('# Header comment');
    expect(migrated).toContain('# --- content ---');
    expect(migrated).toContain('# Trailing comment');
    expect(stdout.some((m) => m.includes('removed') && m.includes('sync'))).toBe(true);
  });

  test('removes server.port and persistence.* leaf fields (project)', async () => {
    const wsPath = projectConfigPath(project.cwd);
    // `content.dir` is the surviving unrelated field; server.port +
    // persistence.* are silent-drop leaves. (server.host / openOnAgentEdit are
    // now removed keys themselves, so they can't serve as preserved siblings.)
    const original = `content:\n  dir: docs\nserver:\n  port: 3000\npersistence:\n  debounceMs: 5000\n  maxDebounceMs: 10000\n`;
    writeConfigYaml(wsPath, original);
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    const migrated = readFileSync(wsPath, 'utf-8');
    expect(migrated).not.toContain('port:');
    expect(migrated).not.toContain('debounceMs');
    expect(migrated).not.toContain('maxDebounceMs');
    // Unrelated field preserved.
    expect(migrated).toContain('dir: docs');
    const wsOutcome = outcome.outcomes.find((o) => o.scope === 'project');
    expect(wsOutcome?.removed.sort()).toEqual(
      ['persistence.debounceMs', 'persistence.maxDebounceMs', 'server.port'].sort(),
    );
  });

  test('removes content.{include,exclude} leaf fields (project)', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const original = `content:\n  dir: .\n  include:\n    - "**/*.md"\n  exclude:\n    - drafts/**\n`;
    writeConfigYaml(wsPath, original);
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    const migrated = readFileSync(wsPath, 'utf-8');
    expect(migrated).not.toContain('include:');
    expect(migrated).not.toContain('exclude:');
    // Sibling field preserved
    expect(migrated).toContain('dir: .');
    const wsOutcome = outcome.outcomes.find((o) => o.scope === 'project');
    expect(wsOutcome?.removed.sort()).toEqual(['content.exclude', 'content.include'].sort());
  });

  test('idempotent — second run is a no-op', async () => {
    const wsPath = projectConfigPath(project.cwd);
    writeConfigYaml(wsPath, 'sync:\n  pushIntervalSeconds: 30\nmcp:\n  autoStart: true\n');
    await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
    });
    const afterFirst = readFileSync(wsPath, 'utf-8');
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stdout).toEqual(['No deprecated fields found.']);
    // File untouched on second pass — bytes-equal
    expect(readFileSync(wsPath, 'utf-8')).toBe(afterFirst);
  });

  test('--dry-run on file with deprecated fields → preview, no write', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const original = 'sync:\n  pushIntervalSeconds: 30\nmcp:\n  autoStart: true\n';
    writeConfigYaml(wsPath, original);
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      dryRun: true,
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(wsPath, 'utf-8')).toBe(original);
    expect(stdout.some((m) => m.includes('[dry-run]') && m.includes('sync'))).toBe(true);
    const wsOutcome = outcome.outcomes.find((o) => o.scope === 'project');
    expect(wsOutcome?.found).toContain('sync');
    expect(wsOutcome?.removed).toEqual([]);
  });

  test('--dry-run on clean file → "No deprecated fields found.", no write', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const original = 'content:\n  dir: docs\n';
    writeConfigYaml(wsPath, original);
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      dryRun: true,
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stdout).toEqual(['No deprecated fields found.']);
    expect(readFileSync(wsPath, 'utf-8')).toBe(original);
  });

  test('--scope project → does not touch user file', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const userPath = userConfigPath(project.userHome);
    writeConfigYaml(wsPath, 'sync:\n  pushIntervalSeconds: 30\n');
    writeConfigYaml(userPath, 'sync:\n  pushIntervalSeconds: 60\n');
    const userOriginal = readFileSync(userPath, 'utf-8');
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(wsPath, 'utf-8')).not.toContain('sync:');
    expect(readFileSync(userPath, 'utf-8')).toBe(userOriginal);
    // Outcomes only includes project, not user
    expect(outcome.outcomes.every((o) => o.scope === 'project')).toBe(true);
  });

  test('--scope user → does not touch project file', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const userPath = userConfigPath(project.userHome);
    writeConfigYaml(wsPath, 'sync:\n  pushIntervalSeconds: 30\n');
    writeConfigYaml(userPath, 'sync:\n  pushIntervalSeconds: 60\n');
    const wsOriginal = readFileSync(wsPath, 'utf-8');
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'user',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(wsPath, 'utf-8')).toBe(wsOriginal);
    expect(readFileSync(userPath, 'utf-8')).not.toContain('sync:');
    expect(outcome.outcomes.every((o) => o.scope === 'user')).toBe(true);
  });

  test('--scope both processes both files', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const userPath = userConfigPath(project.userHome);
    writeConfigYaml(wsPath, 'sync:\n  pushIntervalSeconds: 30\n');
    writeConfigYaml(userPath, 'persistence:\n  debounceMs: 5000\n');
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'both',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(wsPath, 'utf-8')).not.toContain('sync:');
    expect(readFileSync(userPath, 'utf-8')).not.toContain('debounceMs');
    expect(outcome.outcomes.length).toBe(2);
  });

  test('unparseable YAML in project → ok:false with parse error reported', async () => {
    const wsPath = projectConfigPath(project.cwd);
    writeConfigYaml(wsPath, '{{{ not yaml at all\n');
    const wsOriginal = readFileSync(wsPath, 'utf-8');
    const stderr: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
      error: (msg) => stderr.push(msg),
    });
    expect(outcome.ok).toBe(false);
    expect(readFileSync(wsPath, 'utf-8')).toBe(wsOriginal);
    expect(stderr.some((m) => m.includes('Could not parse'))).toBe(true);
  });

  test('writeConfigPatch error path → ok:false, file untouched', async () => {
    const wsPath = projectConfigPath(project.cwd);
    writeConfigYaml(wsPath, 'sync:\n  pushIntervalSeconds: 30\n');
    const wsOriginal = readFileSync(wsPath, 'utf-8');
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
      error: () => {},
      writeConfigPatchFn: async () => ({
        ok: false,
        error: { code: 'WRITE_ERROR', detail: 'simulated disk full' },
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(readFileSync(wsPath, 'utf-8')).toBe(wsOriginal);
    const wsOutcome = outcome.outcomes.find((o) => o.scope === 'project');
    expect(wsOutcome?.error).toContain('simulated disk full');
  });
});

describe('DROPPED_FIELD_PATHS', () => {
  test('is the silent-drop set followed by every removed-key registry path', () => {
    // Silently-dropped sections (no removed-key error) come first.
    expect(DROPPED_FIELD_PATHS.slice(0, 4)).toEqual([
      ['sync'],
      ['persistence', 'debounceMs'],
      ['persistence', 'maxDebounceMs'],
      ['server', 'port'],
    ]);
    // ...then the shared registry, so the "run `ok config migrate`" hint in
    // every removed-key redirect is truthful.
    expect(DROPPED_FIELD_PATHS.slice(4)).toEqual(REMOVED_KEYS.map((k) => k.path));
    // Headline keys that used to be silent are now strippable.
    const dotted = DROPPED_FIELD_PATHS.map((p) => p.join('.'));
    expect(dotted).toContain('folders');
    expect(dotted).toContain('appearance.editorModeDefault');
    expect(dotted).toContain('content.include');
  });
});

describe('buildClearPatchForTest (internal)', () => {
  test('flat path → null at the leaf', () => {
    const patch = buildClearPatchForTest([['sync']]);
    expect(patch).toEqual({ sync: null } as never);
  });

  test('nested paths → nested null leaves; siblings share parent object', () => {
    const patch = buildClearPatchForTest([
      ['persistence', 'debounceMs'],
      ['persistence', 'maxDebounceMs'],
    ]);
    expect(patch).toEqual({
      persistence: { debounceMs: null, maxDebounceMs: null },
    } as never);
  });

  test('mixed paths → all-null leaves rooted in single tree', () => {
    const patch = buildClearPatchForTest([
      ['sync'],
      ['persistence', 'debounceMs'],
      ['server', 'port'],
    ]);
    expect(patch).toEqual({
      sync: null,
      persistence: { debounceMs: null },
      server: { port: null },
    } as never);
  });

  test('empty paths → empty patch', () => {
    expect(buildClearPatchForTest([])).toEqual({} as never);
  });
});
