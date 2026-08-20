import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, getLeafFieldMeta, REMOVED_KEYS } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CONFIG_FILENAME, OK_DIR } from '../constants.ts';
import {
  buildClearPatchForTest,
  configCommand,
  DROPPED_FIELD_PATHS,
  runMigrate,
  runValidate,
  shouldAnnounceRemovedKeys,
} from './config.ts';

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

function projectLocalConfigPath(cwd: string): string {
  // Project-local config lives at `<cwd>/.ok/local/config.yml` (gitignored,
  // per-machine); see `resolveConfigPath('project-local', …)` in core.
  return join(cwd, OK_DIR, 'local', CONFIG_FILENAME);
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
      readProjectLocalFn: () => [],
      loadConfigFn: () =>
        ({
          config: {} as never,
          sources: ['/home/test/project/.ok/config.yml'],
          diagnostics: [],
          sidelined: [],
        }) as never,
      log: (msg) => stderr.push(msg),
      error: (msg) => stderr.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stderr.some((m) => m.includes('✓ Configuration valid'))).toBe(true);
    expect(stderr.some((m) => m.includes('/home/test/project/.ok/config.yml'))).toBe(true);
    expect(stdout).toEqual([]);
  });

  test('degraded layer → headline does not claim valid, and names the file it moved aside', () => {
    // A user whose global config is corrupt gets it renamed out of the way so
    // OK can boot on defaults. Reporting an unqualified "valid" here sends a
    // reader who skims for the checkmark away believing nothing happened, and
    // saying nothing about the rename reads as the file having vanished.
    //
    // The headline stays code-agnostic: this fixture is a YAML_PARSE, where the
    // file read fine and the syntax is what failed, so a "could not be read"
    // summary would send the user after file permissions. `humanFormat` below
    // it names the real cause.
    const stderr: string[] = [];
    const outcome = runValidate({
      readProjectLocalFn: () => [],
      loadConfigFn: () =>
        ({
          config: {} as never,
          sources: ['/home/test/project/.ok/config.yml'],
          diagnostics: [{ code: 'YAML_PARSE', detail: 'unexpected end of flow sequence' }],
          sidelined: [
            {
              from: '/home/test/.ok/global.yml',
              to: '/home/test/.ok/global.yml.invalid-2026-01-01T00-00-00-000Z',
            },
          ],
        }) as never,
      log: (msg) => stderr.push(msg),
      error: (msg) => stderr.push(msg),
    });
    const joined = stderr.join('\n');
    expect(outcome.ok).toBe(true);
    expect(joined).not.toContain('✓ Configuration valid');
    expect(joined).toContain('config layer(s) had issues');
    expect(joined).not.toContain('could not be read');
    expect(joined).toContain('unexpected end of flow sequence');
    expect(joined).toContain('/home/test/.ok/global.yml.invalid-2026-01-01T00-00-00-000Z');
  });

  test('removed keys alone do not qualify the headline', () => {
    // A stripped key leaves the file usable, so it must not downgrade the
    // headline the way an unreadable layer does.
    const stderr: string[] = [];
    runValidate({
      readProjectLocalFn: () => [],
      loadConfigFn: () =>
        ({
          config: {} as never,
          sources: ['/home/test/project/.ok/config.yml'],
          diagnostics: [{ code: 'REMOVED_KEY', path: ['server', 'host'], redirect: 'Use --host.' }],
          sidelined: [],
        }) as never,
      log: (msg) => stderr.push(msg),
      error: (msg) => stderr.push(msg),
    });
    const joined = stderr.join('\n');
    expect(joined).toContain('✓ Configuration valid');
    expect(joined).toContain('server.host');
  });

  test('no sources → "defaults only"', () => {
    const stderr: string[] = [];
    const outcome = runValidate({
      readProjectLocalFn: () => [],
      loadConfigFn: () =>
        ({ config: {} as never, sources: [], diagnostics: [], sidelined: [] }) as never,
      log: (msg) => stderr.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stderr.some((m) => m.includes('defaults only'))).toBe(true);
  });

  test('removed key in project config → valid (exit 0) with the finding + redirect reported', () => {
    // Full path: a committed config carrying a removed key still validates
    // (removed keys never block), and the finding is reported with its
    // replacement guidance. Mirrors the real-loadConfig test above.
    const project = makeTempProject();
    try {
      writeConfigYaml(
        projectConfigPath(project.cwd),
        'content:\n  dir: docs\nserver:\n  host: 0.0.0.0\n',
      );
      const out: string[] = [];
      const outcome = runValidate({
        cwd: project.cwd,
        log: (msg) => out.push(msg),
        error: (msg) => out.push(msg),
      });
      expect(outcome.ok).toBe(true);
      const joined = out.join('\n');
      expect(joined).toContain('✓ Configuration valid');
      // Names the dead key and surfaces its replacement guidance — both the
      // successor config key and the flag the redirect text now points at.
      expect(joined).toContain('server.host');
      expect(joined).toContain('server.bind');
      expect(joined).toContain('--bind');
    } finally {
      project.cleanup();
    }
  });

  test('removed remote-access keys → valid with each finding + successor reported', () => {
    // Parallels the server.host coverage above for the remote-access key
    // removal: remote.url / remote.port / server.publicUrl are removed keys, so
    // a committed config carrying them still validates (removed keys never
    // block) and each is reported with the server.* key that replaced it.
    const project = makeTempProject();
    try {
      writeConfigYaml(
        projectConfigPath(project.cwd),
        'content:\n  dir: docs\nremote:\n  url: https://kb.example.com\n  port: 24550\nserver:\n  publicUrl: https://kb.example.com\n',
      );
      const out: string[] = [];
      const outcome = runValidate({
        cwd: project.cwd,
        log: (msg) => out.push(msg),
        error: (msg) => out.push(msg),
      });
      expect(outcome.ok).toBe(true);
      const joined = out.join('\n');
      expect(joined).toContain('✓ Configuration valid');
      // Each dead key is named and points at its server.* successor.
      expect(joined).toContain('remote.url');
      expect(joined).toContain('remote.port');
      expect(joined).toContain('server.publicUrl');
      expect(joined).toContain('server.externalUrl');
      expect(joined).toContain('server.port');
    } finally {
      project.cleanup();
    }
  });

  test('schema-fail → ok:false and stderr contains the thrown error message', () => {
    const stderr: string[] = [];
    const outcome = runValidate({
      readProjectLocalFn: () => [],
      loadConfigFn: () => {
        throw new Error('Invalid configuration at /tmp/.ok/config.yml:7:18\n  ...');
      },
      error: (msg) => stderr.push(msg),
    });
    expect(outcome.ok).toBe(false);
    expect(stderr.some((m) => m.includes('Invalid configuration'))).toBe(true);
    expect(stderr.some((m) => m.includes(':7:18'))).toBe(true);
  });

  // `loadConfig` merges user + committed project only, so the per-machine layer
  // — where a stale key silently discards a live `autoSync.mode` — was the one
  // `validate` could not see: a user following the docs got a ✓ and no way to
  // find the dead key without a running server.
  test('a removed key in project-local config is reported, not answered with ✓', () => {
    const project = makeTempProject();
    try {
      writeConfigYaml(
        projectLocalConfigPath(project.cwd),
        'autoSync:\n  mode: full\nappearance:\n  sidebar:\n    showAllFiles: false\n',
      );
      const out: string[] = [];
      const outcome = runValidate({
        cwd: project.cwd,
        log: (msg) => out.push(msg),
        error: (msg) => out.push(msg),
      });

      const joined = out.join('\n');
      expect(outcome.ok).toBe(true);
      expect(joined).toContain('appearance.sidebar.showAllFiles');
      // A removed key leaves the layer usable, so the headline stays clean —
      // the finding below it is what the user acts on.
      expect(joined).toContain('✓ Configuration valid');
    } finally {
      project.cleanup();
    }
  });

  test('reporting the project-local layer never renames it', () => {
    // The read is `sideline: false`: `validate` describes a corrupt layer, it
    // does not quarantine one. A command that moved a file aside just for being
    // inspected would be a destructive read.
    const project = makeTempProject();
    try {
      const localPath = projectLocalConfigPath(project.cwd);
      writeConfigYaml(localPath, 'autoSync:\n  mode: [invalid yaml');
      const out: string[] = [];

      const outcome = runValidate({
        cwd: project.cwd,
        log: (msg) => out.push(msg),
        error: (msg) => out.push(msg),
      });

      expect(outcome.ok).toBe(true);
      expect(out.join('\n')).toContain('config layer(s) had issues');
      expect(existsSync(localPath)).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  test('source-located error rendering through real loadConfig', () => {
    const project = makeTempProject();
    try {
      const wsPath = projectConfigPath(project.cwd);
      // A project-scoped invalid value (server.port out of range) survives the
      // scope-aware merge and fails the single merged parse — user-scoped keys
      // like appearance.theme are dropped before validation now, so they can't
      // exercise the source-location path from the project file.
      writeConfigYaml(wsPath, `server:\n  port: 99999999\n`);
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

describe('shouldAnnounceRemovedKeys', () => {
  test('suppressed for the config command family, which reports them itself', () => {
    // `config validate` renders the findings as its result and `config migrate`
    // removes them; a startup announcement would print each finding twice.
    expect(shouldAnnounceRemovedKeys('config')).toBe(false);
  });

  test('announced for every other command, which would otherwise never show them', () => {
    for (const name of ['start', 'ui', 'mcp', 'status', 'embeddings', undefined]) {
      expect(shouldAnnounceRemovedKeys(name)).toBe(true);
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

  test('removes persistence.* leaf fields while preserving the live server.port key (project)', async () => {
    const wsPath = projectConfigPath(project.cwd);
    // `content.dir` is the surviving unrelated field; persistence.* are the
    // silent-drop leaves. `server.port` is present precisely to prove migrate
    // does NOT touch it — it returned as a live schema key, so a codemod that
    // stripped it would destroy config on the exact command every removed-key
    // redirect tells the user to run.
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
    expect(migrated).not.toContain('debounceMs');
    expect(migrated).not.toContain('maxDebounceMs');
    // The live server.port key survives untouched.
    expect(migrated).toContain('port: 3000');
    // Unrelated field preserved.
    expect(migrated).toContain('dir: docs');
    const wsOutcome = outcome.outcomes.find((o) => o.scope === 'project');
    expect(wsOutcome?.removed.sort()).toEqual(
      ['persistence.debounceMs', 'persistence.maxDebounceMs'].sort(),
    );
  });

  test('removes remote.* and server.publicUrl while preserving live server.* keys (project)', async () => {
    const wsPath = projectConfigPath(project.cwd);
    // The removed remote-access keys (remote.url, remote.port — an entire
    // top-level `remote:` section — plus server.publicUrl) are stripped; the
    // live successors (server.externalUrl, server.port) must survive. A codemod
    // that touched them would destroy config on the exact command the removed-key
    // redirects tell users to run.
    const original = `content:\n  dir: docs\nremote:\n  url: https://old-remote.example.com\n  port: 24550\nserver:\n  port: 8080\n  externalUrl: https://kb.example.com\n  publicUrl: https://old-public.example.com\n`;
    writeConfigYaml(wsPath, original);
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    const migrated = readFileSync(wsPath, 'utf-8');
    // Deprecated keys and their values are gone.
    expect(migrated).not.toContain('publicUrl');
    expect(migrated).not.toContain('old-remote.example.com');
    expect(migrated).not.toContain('old-public.example.com');
    expect(migrated).not.toContain('24550');
    // Live successors survive untouched.
    expect(migrated).toContain('port: 8080');
    expect(migrated).toContain('externalUrl: https://kb.example.com');
    expect(migrated).toContain('dir: docs');
    const wsOutcome = outcome.outcomes.find((o) => o.scope === 'project');
    expect(wsOutcome?.removed.sort()).toEqual(
      ['remote.port', 'remote.url', 'server.publicUrl'].sort(),
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

  test('--scope project-local strips removed keys, preserves other local settings', async () => {
    const localPath = projectLocalConfigPath(project.cwd);
    // The field-bug shape: an explicit per-machine autoSync.mode alongside the
    // dead appearance.sidebar.showAllFiles key.
    writeConfigYaml(
      localPath,
      'autoSync:\n  mode: full\nappearance:\n  sidebar:\n    showAllFiles: true\n',
    );
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project-local',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    const migrated = readFileSync(localPath, 'utf-8');
    expect(migrated).not.toContain('showAllFiles');
    // The unrelated per-machine setting survives on disk.
    expect(migrated).toContain('mode: full');
    const localOutcome = outcome.outcomes.find((o) => o.scope === 'project-local');
    expect(localOutcome?.removed).toContain('appearance.sidebar.showAllFiles');
    expect(outcome.outcomes.every((o) => o.scope === 'project-local')).toBe(true);
  });

  test('--scope project-local is idempotent — second run writes nothing', async () => {
    const localPath = projectLocalConfigPath(project.cwd);
    writeConfigYaml(
      localPath,
      'autoSync:\n  mode: full\nappearance:\n  sidebar:\n    showAllFiles: true\n',
    );
    await runMigrate({
      cwd: project.cwd,
      scope: 'project-local',
      homedirOverride: project.userHome,
      log: () => {},
    });
    const afterFirst = readFileSync(localPath, 'utf-8');
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project-local',
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(stdout).toEqual(['No deprecated fields found.']);
    expect(readFileSync(localPath, 'utf-8')).toBe(afterFirst);
  });

  test('--scope project-local --dry-run previews without writing', async () => {
    const localPath = projectLocalConfigPath(project.cwd);
    const original = 'autoSync:\n  mode: full\nappearance:\n  sidebar:\n    showAllFiles: true\n';
    writeConfigYaml(localPath, original);
    const stdout: string[] = [];
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project-local',
      dryRun: true,
      homedirOverride: project.userHome,
      log: (msg) => stdout.push(msg),
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(localPath, 'utf-8')).toBe(original);
    expect(stdout.some((m) => m.includes('[dry-run]') && m.includes('showAllFiles'))).toBe(true);
    const localOutcome = outcome.outcomes.find((o) => o.scope === 'project-local');
    expect(localOutcome?.removed).toEqual([]);
  });

  test('--scope all migrates project, project-local, and user files', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const localPath = projectLocalConfigPath(project.cwd);
    const userPath = userConfigPath(project.userHome);
    writeConfigYaml(wsPath, 'folders:\n  - notes\ncontent:\n  dir: docs\n');
    writeConfigYaml(
      localPath,
      'autoSync:\n  mode: full\nappearance:\n  sidebar:\n    showAllFiles: true\n',
    );
    writeConfigYaml(userPath, 'appearance:\n  editorModeDefault: source\n');
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'all',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(wsPath, 'utf-8')).not.toContain('folders');
    expect(readFileSync(wsPath, 'utf-8')).toContain('dir: docs');
    expect(readFileSync(localPath, 'utf-8')).not.toContain('showAllFiles');
    expect(readFileSync(localPath, 'utf-8')).toContain('mode: full');
    expect(readFileSync(userPath, 'utf-8')).not.toContain('editorModeDefault');
    expect(outcome.outcomes.map((o) => o.scope).sort()).toEqual([
      'project',
      'project-local',
      'user',
    ]);
  });

  test('--scope both leaves the project-local file untouched (alias = project + user)', async () => {
    const wsPath = projectConfigPath(project.cwd);
    const localPath = projectLocalConfigPath(project.cwd);
    const userPath = userConfigPath(project.userHome);
    writeConfigYaml(wsPath, 'folders:\n  - notes\n');
    writeConfigYaml(localPath, 'appearance:\n  sidebar:\n    showAllFiles: true\n');
    writeConfigYaml(userPath, 'appearance:\n  editorModeDefault: source\n');
    const localOriginal = readFileSync(localPath, 'utf-8');
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'both',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(wsPath, 'utf-8')).not.toContain('folders');
    expect(readFileSync(userPath, 'utf-8')).not.toContain('editorModeDefault');
    // project-local is deliberately outside `both` — byte-for-byte unchanged.
    expect(readFileSync(localPath, 'utf-8')).toBe(localOriginal);
    expect(outcome.outcomes.map((o) => o.scope).sort()).toEqual(['project', 'user']);
  });

  test('the default scope reaches project-local, so the redirect hint is truthful', async () => {
    // Every removed-key redirect tells the user to run a bare `ok config
    // migrate`. If the default reach excluded project-local, following that
    // instruction verbatim would not fix a dead key living there.
    const wsPath = projectConfigPath(project.cwd);
    const localPath = projectLocalConfigPath(project.cwd);
    const userPath = userConfigPath(project.userHome);
    writeConfigYaml(wsPath, 'folders:\n  - notes\n');
    writeConfigYaml(localPath, 'appearance:\n  sidebar:\n    showAllFiles: true\n');
    writeConfigYaml(userPath, 'appearance:\n  editorModeDefault: source\n');
    // No `scope` passed — exercises the command's default reach.
    const outcome = await runMigrate({
      cwd: project.cwd,
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(localPath, 'utf-8')).not.toContain('showAllFiles');
    expect(outcome.outcomes.map((o) => o.scope).sort()).toEqual([
      'project',
      'project-local',
      'user',
    ]);
  });

  test('content.include is stripped without writing .okignore', async () => {
    const wsPath = projectConfigPath(project.cwd);
    writeConfigYaml(wsPath, 'content:\n  dir: .\n  include:\n    - "docs/**/*.md"\n');
    // content.dir defaults to '.', so any auto-created .okignore would land at
    // the project root beside .ok/.
    const okignorePath = join(project.cwd, '.okignore');
    const outcome = await runMigrate({
      cwd: project.cwd,
      scope: 'project',
      homedirOverride: project.userHome,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    const migrated = readFileSync(wsPath, 'utf-8');
    expect(migrated).not.toContain('include:');
    expect(migrated).toContain('dir: .');
    // include→.okignore inverts intent, so the codemod only deletes the dead
    // key — it must never synthesize an .okignore on the user's behalf.
    expect(existsSync(okignorePath)).toBe(false);
    const wsOutcome = outcome.outcomes.find((o) => o.scope === 'project');
    expect(wsOutcome?.removed).toContain('content.include');
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

describe('configCommand migrate --scope', () => {
  function migrateSubcommand() {
    const migrate = configCommand().commands.find((c) => c.name() === 'migrate');
    if (migrate === undefined) throw new Error('migrate subcommand not registered');
    return migrate;
  }

  test('help advertises project | project-local | user | all', () => {
    const migrate = migrateSubcommand();
    const scopeOption = migrate.options.find((o) => o.long === '--scope');
    // The option description is the source of the rendered help line; asserting
    // it directly avoids coupling to commander's terminal-width wrapping.
    expect(scopeOption?.description).toBe(
      'Which scope to migrate: project | project-local | user | all',
    );
    expect(migrate.helpInformation()).toContain('project-local');
  });

  test('unrecognized --scope prints the accepted values and exits 2', async () => {
    const savedExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await configCommand().parseAsync(['migrate', '--scope', 'bogus'], { from: 'user' });
      expect(process.exitCode).toBe(2);
      const printed = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).toContain('project | project-local | user | all');
    } finally {
      // Restore before assertions can leak exit code 2 to the vitest process.
      process.exitCode = savedExitCode;
      errorSpy.mockRestore();
    }
  });
});

describe('DROPPED_FIELD_PATHS', () => {
  test('is the silent-drop set followed by every removed-key registry path', () => {
    // Silently-dropped sections (no removed-key error) come first. `server.port`
    // was here until it returned as a live schema key (see the disjointness
    // guard below).
    expect(DROPPED_FIELD_PATHS.slice(0, 3)).toEqual([
      ['sync'],
      ['persistence', 'debounceMs'],
      ['persistence', 'maxDebounceMs'],
    ]);
    // ...then the shared registry, so the "run `ok config migrate`" hint in
    // every removed-key redirect is truthful.
    expect(DROPPED_FIELD_PATHS.slice(3)).toEqual(REMOVED_KEYS.map((k) => k.path));
    // Headline keys that used to be silent are now strippable.
    const dotted = DROPPED_FIELD_PATHS.map((p) => p.join('.'));
    expect(dotted).toContain('folders');
    expect(dotted).toContain('appearance.editorModeDefault');
    expect(dotted).toContain('content.include');
  });

  test('no dropped path is a live ConfigSchema leaf (codemod never deletes a key the engine reads)', () => {
    // The failure this guards against: a key resurrected into ConfigSchema
    // while still listed here, so `ok config migrate` silently deletes live
    // user config. `server.port` was exactly that. A dropped path must resolve
    // to NO field metadata — it is either a whole removed section or a leaf the
    // schema no longer declares.
    const live = DROPPED_FIELD_PATHS.filter(
      (path) => getLeafFieldMeta(ConfigSchema, path) !== undefined,
    ).map((path) => path.join('.'));
    expect(live).toEqual([]);
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
