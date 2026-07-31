import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import { collectConfigDiagnostics } from './collect-config-diagnostics.ts';
import type { WriteScope } from './errors.ts';
import { REMOVED_KEYS } from './removed-keys.ts';
import { resolveConfigPath } from './write-config-patch.ts';

/** True when `value` is a non-null, non-array object. */
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

let projectDir: string;
let homeDir: string;
/** Diagnostics are returned, not logged — keep test output clean. */
const quiet = () => {};

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = resolve(tmpdir(), `ok-diag-project-${stamp}`);
  homeDir = resolve(tmpdir(), `ok-diag-home-${stamp}`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

/** Write `value` as YAML at the config path for `scope`; returns that path. */
function writeScopeConfig(scope: WriteScope, value: Record<string, unknown>): string {
  const file = resolveConfigPath(scope, projectDir, homeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(value), 'utf-8');
  return file;
}

/** Write raw (possibly malformed) bytes at the config path for `scope`. */
function writeScopeRaw(scope: WriteScope, raw: string): string {
  const file = resolveConfigPath(scope, projectDir, homeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw, 'utf-8');
  return file;
}

function collect() {
  return collectConfigDiagnostics({ cwd: projectDir, homedirOverride: homeDir, warn: quiet });
}

describe('collectConfigDiagnostics', () => {
  test('no config files → empty report', () => {
    expect(collect()).toEqual({ diagnostics: [] });
  });

  test('a single removed key in project-local surfaces one scoped finding', () => {
    const entry = REMOVED_KEYS.find((k) => k.path.join('.') === 'appearance.sidebar.showAllFiles');
    if (!entry) throw new Error('fixture key missing from registry');
    const config: Record<string, unknown> = {};
    setPath(config, entry.path, false);
    const file = writeScopeConfig('project-local', config);

    const { diagnostics } = collect();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      code: 'REMOVED_KEY',
      scope: 'project-local',
      file,
      path: entry.path,
      redirect: entry.redirect,
    });
  });

  test('reports each layer with its own scope, file, and key path', () => {
    // Three different registry keys, one per layer.
    const userKey = ['server', 'host'];
    const projectKey = ['upload', 'maxBytes'];
    const localKey = ['appearance', 'sidebar', 'showAllFiles'];

    const userCfg: Record<string, unknown> = {};
    setPath(userCfg, userKey, 'example.internal');
    const userFile = writeScopeConfig('user', userCfg);

    const projectCfg: Record<string, unknown> = {};
    setPath(projectCfg, projectKey, 1024);
    const projectFile = writeScopeConfig('project', projectCfg);

    const localCfg: Record<string, unknown> = {};
    setPath(localCfg, localKey, false);
    const localFile = writeScopeConfig('project-local', localCfg);

    const { diagnostics } = collect();

    const byScope = new Map(diagnostics.map((d) => [d.scope, d]));
    expect(byScope.get('user')).toMatchObject({ scope: 'user', file: userFile, path: userKey });
    expect(byScope.get('project')).toMatchObject({
      scope: 'project',
      file: projectFile,
      path: projectKey,
    });
    expect(byScope.get('project-local')).toMatchObject({
      scope: 'project-local',
      file: localFile,
      path: localKey,
    });
    // Every requested layer is represented exactly once.
    expect(diagnostics).toHaveLength(3);
  });

  test('every registry key is reported with its scope + registry redirect, and no on-disk value leaks', () => {
    for (const entry of REMOVED_KEYS) {
      const config: Record<string, unknown> = {
        // A schema-valid sibling whose distinctive value must never appear in
        // the report — proves the finding carries key identity, not values.
        content: { dir: 'SENTINEL_SIBLING_DIR' },
      };
      setPath(config, entry.path, 'SENTINEL_REMOVED_LEAF');
      writeScopeConfig('project-local', config);

      const { diagnostics } = collect();

      const finding = diagnostics.find(
        (d) => d.code === 'REMOVED_KEY' && d.path.join('.') === entry.path.join('.'),
      );
      expect(finding, `finding for ${entry.path.join('.')}`).toBeDefined();
      expect(finding).toMatchObject({ scope: 'project-local', redirect: entry.redirect });

      const serialized = JSON.stringify(diagnostics);
      expect(serialized).not.toContain('SENTINEL_SIBLING_DIR');
      expect(serialized).not.toContain('SENTINEL_REMOVED_LEAF');

      // Reset for the next entry so findings don't accumulate across the loop.
      rmSync(resolveConfigPath('project-local', projectDir, homeDir), { force: true });
    }
  });

  test('the response body carries no raw config value from any layer', () => {
    const userCfg: Record<string, unknown> = { content: { dir: 'USER_ONLY_VALUE' } };
    setPath(userCfg, ['server', 'host'], 'USER_HOST_VALUE');
    writeScopeConfig('user', userCfg);

    const projectCfg: Record<string, unknown> = { content: { dir: 'PROJECT_ONLY_VALUE' } };
    setPath(projectCfg, ['folders'], ['PROJECT_FOLDER_VALUE']);
    writeScopeConfig('project', projectCfg);

    const localCfg: Record<string, unknown> = { content: { dir: 'LOCAL_ONLY_VALUE' } };
    setPath(localCfg, ['appearance', 'sidebar', 'showAllFiles'], false);
    writeScopeConfig('project-local', localCfg);

    const serialized = JSON.stringify(collect());
    for (const secret of [
      'USER_ONLY_VALUE',
      'USER_HOST_VALUE',
      'PROJECT_ONLY_VALUE',
      'PROJECT_FOLDER_VALUE',
      'LOCAL_ONLY_VALUE',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('a schema-invalid layer surfaces a value-free SCHEMA_INVALID finding', () => {
    const file = writeScopeRaw('project-local', 'appearance:\n  theme: midnight\n');

    const { diagnostics } = collect();

    expect(diagnostics).toEqual([{ code: 'SCHEMA_INVALID', scope: 'project-local', file }]);
    // The offending value never crosses the boundary.
    expect(JSON.stringify(diagnostics)).not.toContain('midnight');
    // Read is non-destructive — the file is reported, never sidelined/renamed.
    expect(existsSync(file)).toBe(true);
  });

  test('an unparseable layer surfaces a value-free YAML_PARSE finding without renaming the file', () => {
    const file = writeScopeRaw('project', 'content:\n  dir: [invalid yaml');

    const { diagnostics } = collect();

    expect(diagnostics).toEqual([{ code: 'YAML_PARSE', scope: 'project', file }]);
    expect(existsSync(file)).toBe(true);
  });

  // A directory where the file belongs: the path exists, so the missing-file
  // arm is skipped and the read itself throws. This is the only variant whose
  // wire projection was reachable only through `readConfigSafely` in isolation
  // — the collector's own arm for it was untested.
  test('a layer that cannot be read at all surfaces a value-free UNREADABLE finding', () => {
    const file = resolveConfigPath('project-local', projectDir, homeDir);
    mkdirSync(file, { recursive: true });

    const { diagnostics } = collect();

    expect(diagnostics).toEqual([{ code: 'UNREADABLE', scope: 'project-local', file }]);
  });
});
