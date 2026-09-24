import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import { collectConfigDiagnostics } from './collect-config-diagnostics.ts';
import { serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey } from './config-leak-serializer.test-helper.ts';
import type { WriteScope } from './errors.ts';
import { REMOVED_KEYS } from './removed-keys.ts';
import { resolveConfigPath } from './write-config-patch.ts';

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

let projectDir: string;
let homeDir: string;
const quiet = () => {};

const CONFIG_VALUES_THE_FINDING_FIELDS_MUST_NEVER_ECHO = [
  'SENTINEL_SIBLING_DIR',
  'SENTINEL_REMOVED_LEAF',
  'USER_ONLY_VALUE',
  'USER_HOST_VALUE',
  'PROJECT_ONLY_VALUE',
  'PROJECT_FOLDER_VALUE',
  'LOCAL_ONLY_VALUE',
  'midnight',
  'PRIVATE_INVALID_VALUE',
  '900000',
] as const;

const FIXTURE_PATH_DELIBERATELY_CARRIES_EVERY_FORBIDDEN_VALUE =
  CONFIG_VALUES_THE_FINDING_FIELDS_MUST_NEVER_ECHO.join('-');

const NAME_MAX_BYTES_PER_PATH_COMPONENT = 255;

const ROOM_FOR_ONE_MORE_FORBIDDEN_VALUE =
  1 + Math.max(...CONFIG_VALUES_THE_FINDING_FIELDS_MUST_NEVER_ECHO.map((value) => value.length));

const FIXTURE_CONFIG_SCOPES = [
  'user',
  'project',
  'project-local',
] as const satisfies readonly WriteScope[];

function suppliedConfigPaths(): readonly string[] {
  return FIXTURE_CONFIG_SCOPES.map((scope) => resolveConfigPath(scope, projectDir, homeDir));
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = resolve(
    tmpdir(),
    `ok-diag-project-${FIXTURE_PATH_DELIBERATELY_CARRIES_EVERY_FORBIDDEN_VALUE}-${stamp}`,
  );
  homeDir = resolve(
    tmpdir(),
    `ok-diag-home-${FIXTURE_PATH_DELIBERATELY_CARRIES_EVERY_FORBIDDEN_VALUE}-${stamp}`,
  );
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function writeScopeConfig(scope: WriteScope, value: Record<string, unknown>): string {
  const file = resolveConfigPath(scope, projectDir, homeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(value), 'utf-8');
  return file;
}

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
  test('reports invalid host declarations at their user source location', () => {
    const file = writeScopeConfig('user', { git: { hosts: { h: { provider: 'gitlab' } } } });
    expect(collect().diagnostics).toContainEqual({
      code: 'VALUE_FALLBACK',
      scope: 'user',
      file,
      issues: [
        expect.objectContaining({
          path: ['git', 'hosts', 'h', 'provider'],
          line: expect.any(Number),
        }),
      ],
    });
  });

  test('the fixture path carries every forbidden value, so no absence check can pass on path luck', () => {
    for (const value of CONFIG_VALUES_THE_FINDING_FIELDS_MUST_NEVER_ECHO) {
      expect(projectDir, `projectDir must carry ${value}`).toContain(value);
      expect(homeDir, `homeDir must carry ${value}`).toContain(value);
    }

    for (const dir of [projectDir, homeDir]) {
      const component = basename(dir);
      expect(
        component.length + ROOM_FOR_ONE_MORE_FORBIDDEN_VALUE,
        `${component} has no room left to carry another forbidden value: beforeEach mkdirSync throws ENAMETOOLONG before any assertion in this file can report it`,
      ).toBeLessThanOrEqual(NAME_MAX_BYTES_PER_PATH_COMPONENT);
    }
  });

  test('the leak serializer exempts exactly the fixture-supplied config paths under the file key, and no other value and no other key', () => {
    const supplied = resolveConfigPath('project', projectDir, homeDir);
    const suppliedPathUnderAKeyOtherThanFile = resolveConfigPath('user', projectDir, homeDir);
    const configValueThatHappensToSitUnderTheFixtureRoot = resolve(
      projectDir,
      'DECOY_UNDER_FIXTURE_ROOT',
    );

    const serialized = serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey(
      {
        file: supplied,
        sidelinedTo: suppliedPathUnderAKeyOtherThanFile,
        issues: [{ file: 'VALUE_KEYED_FILE_BUT_NOT_A_SUPPLIED_PATH' }],
        detail: configValueThatHappensToSitUnderTheFixtureRoot,
      },
      suppliedConfigPaths(),
    );

    expect(serialized).not.toContain(JSON.stringify(supplied));
    expect(
      serialized,
      'the exemption is not confined to the file key: it stripped a supplied path from another key',
    ).toContain(JSON.stringify(suppliedPathUnderAKeyOtherThanFile));
    expect(serialized).toContain(JSON.stringify('VALUE_KEYED_FILE_BUT_NOT_A_SUPPLIED_PATH'));
    expect(serialized).toContain(JSON.stringify(configValueThatHappensToSitUnderTheFixtureRoot));
  });

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
    expect(diagnostics).toHaveLength(3);
  });

  test('every registry key is reported with its scope + registry redirect, and no on-disk value leaks', () => {
    for (const entry of REMOVED_KEYS) {
      const config: Record<string, unknown> = {
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

      const serialized = serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey(
        diagnostics,
        suppliedConfigPaths(),
      );
      expect(serialized).not.toContain('SENTINEL_SIBLING_DIR');
      expect(serialized).not.toContain('SENTINEL_REMOVED_LEAF');

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

    const report = collect();

    expect(report.diagnostics).toMatchObject([
      { code: 'REMOVED_KEY', scope: 'user', path: ['server', 'host'] },
      { code: 'REMOVED_KEY', scope: 'project', path: ['folders'] },
      {
        code: 'REMOVED_KEY',
        scope: 'project-local',
        path: ['appearance', 'sidebar', 'showAllFiles'],
      },
    ]);

    const serialized = serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey(
      report,
      suppliedConfigPaths(),
    );
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
    expect(
      serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey(
        diagnostics,
        suppliedConfigPaths(),
      ),
    ).not.toContain('midnight');
    expect(existsSync(file)).toBe(true);
  });

  test('recovered transport values surface one value-free finding without renaming the file', () => {
    const file = writeScopeRaw(
      'project-local',
      'search:\n  semantic:\n    maxBatchSize: PRIVATE_INVALID_VALUE\n    docTimeoutMs: 900000\n',
    );

    const { diagnostics } = collect();

    expect(diagnostics).toEqual([
      {
        code: 'VALUE_FALLBACK',
        scope: 'project-local',
        file,
        issues: [
          {
            path: ['search', 'semantic', 'maxBatchSize'],
            message: 'Expected an integer between 1 and 2048; using default 96.',
            line: 3,
            column: 19,
          },
          {
            path: ['search', 'semantic', 'docTimeoutMs'],
            message: 'Expected an integer between 1 and 600000; using default 30000.',
            line: 4,
            column: 19,
          },
        ],
      },
    ]);
    const valueBearingFields = serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey(
      diagnostics,
      suppliedConfigPaths(),
    );
    expect(valueBearingFields).not.toContain('PRIVATE_INVALID_VALUE');
    expect(valueBearingFields).not.toContain('900000');
    expect(existsSync(file)).toBe(true);
  });

  test('an unparseable layer surfaces a value-free YAML_PARSE finding without renaming the file', () => {
    const file = writeScopeRaw('project', 'content:\n  dir: [invalid yaml');

    const { diagnostics } = collect();

    expect(diagnostics).toEqual([{ code: 'YAML_PARSE', scope: 'project', file }]);
    expect(existsSync(file)).toBe(true);
  });

  test('a layer that cannot be read at all surfaces a value-free UNREADABLE finding', () => {
    const file = resolveConfigPath('project-local', projectDir, homeDir);
    mkdirSync(file, { recursive: true });

    const { diagnostics } = collect();

    expect(diagnostics).toEqual([{ code: 'UNREADABLE', scope: 'project-local', file }]);
  });

  test('a report mixing REMOVED_KEY and VALUE_FALLBACK pins file on both arms and proves the leak scan is not vacuous', () => {
    const removed = REMOVED_KEYS.find(
      (k) => k.path.join('.') === 'appearance.sidebar.showAllFiles',
    );
    if (!removed) throw new Error('fixture key missing from registry');

    const projectCfg: Record<string, unknown> = { content: { dir: 'LEAK_PROBE_SIBLING_DIR' } };
    setPath(projectCfg, removed.path, 'LEAK_PROBE_REMOVED_LEAF');
    const projectFile = writeScopeConfig('project', projectCfg);

    const localFile = writeScopeRaw(
      'project-local',
      'search:\n  semantic:\n    maxBatchSize: LEAK_PROBE_FALLBACK_INPUT\n',
    );

    const { diagnostics } = collect();

    expect(diagnostics).toMatchObject([
      { code: 'REMOVED_KEY', scope: 'project', file: projectFile, path: removed.path },
      { code: 'VALUE_FALLBACK', scope: 'project-local', file: localFile },
    ]);

    const valueBearingFields = serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey(
      diagnostics,
      suppliedConfigPaths(),
    );
    expect(
      valueBearingFields,
      'the leak serializer produced no haystack, so every absence check in this file is vacuous',
    ).toContain(JSON.stringify(removed.path));
    for (const probe of [
      'LEAK_PROBE_SIBLING_DIR',
      'LEAK_PROBE_REMOVED_LEAF',
      'LEAK_PROBE_FALLBACK_INPUT',
    ]) {
      expect(valueBearingFields, `raw config value ${probe} reached a finding field`).not.toContain(
        probe,
      );
    }
  });
});
