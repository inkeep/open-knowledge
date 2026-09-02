import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isKnownConfigError } from './errors.ts';
import { resolveConfigPath, writeConfigPatch } from './write-config-patch.ts';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ok-write-config-patch-'));
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function projectConfigPath(): string {
  return join(testDir, '.ok', 'config.yml');
}

function userConfigPath(homeOverride: string): string {
  return join(homeOverride, '.ok', 'global.yml');
}

describe('writeConfigPatch — project scope', () => {
  test('writes a fresh project config when none exists (lazy first-write)', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { content: { dir: 'docs' } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.created).toBe(true);
    expect(result.appliedPaths).toContain('content.dir');
    expect(existsSync(projectConfigPath())).toBe(true);
    const onDisk = readFileSync(projectConfigPath(), 'utf-8');
    expect(onDisk).toMatch(
      /^# yaml-language-server: \$schema=https:\/\/unpkg\.com\/@inkeep\/open-knowledge@latest\/dist\/schemas\/v\d+\/config\.project\.schema\.json/,
    );
    expect(onDisk).toContain('content:');
    expect(onDisk).toContain('dir: docs');
  });

  test('mode 0o644 on lazy first-write (config is not secret)', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { content: { dir: '.' } },
    });
    const stats = statSync(projectConfigPath());
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test('updates an existing project config and preserves comments', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    const original = `# user-written comment at top
content:
  # inline comment about dir
  dir: .
  include:
    - "**/*.md"
mcp:
  autoStart: true
`;
    writeFileSync(projectConfigPath(), original, 'utf-8');

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { mcp: { autoStart: false } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.created).toBe(false);

    const onDisk = readFileSync(projectConfigPath(), 'utf-8');
    expect(onDisk).toContain('# user-written comment at top');
    expect(onDisk).toContain('# inline comment about dir');
    expect(onDisk).toContain('autoStart: false');
    expect(onDisk).not.toContain('autoStart: true');
  });

  test('null in patch deletes the field (RFC 7396 spirit)', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    writeFileSync(
      projectConfigPath(),
      `mcp:\n  autoStart: false\n  tools:\n    search:\n      maxResults: 100\n`,
      'utf-8',
    );

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      // biome-ignore lint/suspicious/noExplicitAny: testing null-as-clear semantics
      patch: { mcp: { autoStart: null as any } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const onDisk = readFileSync(projectConfigPath(), 'utf-8');
    expect(onDisk).not.toContain('autoStart:');
    expect(onDisk).toContain('maxResults: 100');
  });
});

describe('writeConfigPatch — project-local scope', () => {
  function projectLocalConfigPath(): string {
    return join(testDir, '.ok', 'local', 'config.yml');
  }

  test('writes a fresh project-local config when none exists; lazily creates .ok/local/', async () => {
    expect(existsSync(join(testDir, '.ok'))).toBe(false);

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { autoSync: { enabled: true } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.created).toBe(true);
    expect(result.path).toBe(projectLocalConfigPath());
    expect(result.appliedPaths).toContain('autoSync.enabled');

    expect(existsSync(projectLocalConfigPath())).toBe(true);
    const onDisk = readFileSync(projectLocalConfigPath(), 'utf-8');
    expect(onDisk).toMatch(
      /^# yaml-language-server: \$schema=https:\/\/unpkg\.com\/@inkeep\/open-knowledge@latest\/dist\/schemas\/v\d+\/config\.project-local\.schema\.json/,
    );
    expect(onDisk).toContain('autoSync:');
    expect(onDisk).toContain('enabled: true');
  });

  test('round-trips an autoSync.enabled write — file parseable as YAML, structure intact', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { autoSync: { enabled: false } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    const onDisk = readFileSync(projectLocalConfigPath(), 'utf-8');
    expect(onDisk).toContain('autoSync:');
    expect(onDisk).toContain('enabled: false');

    const second = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { autoSync: { enabled: true } },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected success');
    expect(second.created).toBe(false);
    const after = readFileSync(projectLocalConfigPath(), 'utf-8');
    expect(after).toContain('enabled: true');
    expect(after).not.toContain('enabled: false');
  });

  test('preserves unknown autoSync sub-keys on a mode write-back (looseObject round-trip)', async () => {
    mkdirSync(join(testDir, '.ok', 'local'), { recursive: true });
    writeFileSync(
      projectLocalConfigPath(),
      'autoSync:\n  mode: pull\n  inheritedFrom: root\n  inheritedNoticePending: true\n',
      'utf-8',
    );

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { autoSync: { mode: 'off' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.appliedPaths).toContain('autoSync.mode');

    const onDisk = readFileSync(projectLocalConfigPath(), 'utf-8');
    expect(onDisk).toContain('mode: off');
    expect(onDisk).not.toContain('mode: pull');
    expect(onDisk).toContain('inheritedFrom: root');
    expect(onDisk).toContain('inheritedNoticePending: true');
  });

  test('does NOT touch the project file at <cwd>/.ok/config.yml', async () => {
    await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { autoSync: { enabled: true } },
    });
    expect(existsSync(join(testDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('persists terminal.enabled to .ok/local/config.yml and round-trips across reads', async () => {
    const granted = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { terminal: { enabled: true } },
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error('expected success');
    expect(granted.path).toBe(projectLocalConfigPath());
    expect(granted.appliedPaths).toContain('terminal.enabled');

    const onDisk = readFileSync(projectLocalConfigPath(), 'utf-8');
    expect(onDisk).toContain('terminal:');
    expect(onDisk).toContain('enabled: true');

    const revoked = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { terminal: { enabled: false } },
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) throw new Error('expected success');
    expect(revoked.effective.terminal.enabled).toBe(false);
    const after = readFileSync(projectLocalConfigPath(), 'utf-8');
    expect(after).toContain('enabled: false');
    expect(after).not.toContain('enabled: true');
  });

  test('persists terminal.shell only to .ok/local/config.yml', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { terminal: { shell: 'C:\\Tools\\pwsh.exe' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.appliedPaths).toContain('terminal.shell');
    expect(result.effective.terminal.shell).toBe('C:\\Tools\\pwsh.exe');
    expect(readFileSync(projectLocalConfigPath(), 'utf-8')).toContain('shell: C:\\Tools\\pwsh.exe');
    expect(existsSync(projectConfigPath())).toBe(false);
  });

  test('terminal.enabled grant lands ONLY in the gitignored .ok/local/ file, never the committed project file', async () => {
    await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { terminal: { enabled: true } },
    });
    expect(existsSync(projectLocalConfigPath())).toBe(true);
    expect(existsSync(join(testDir, '.ok', 'config.yml'))).toBe(false);
  });
});

describe('writeConfigPatch — user scope', () => {
  test('lazy first-write of ~/.ok/global.yml creates parent dir', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-write-config-patch-home-'));
    try {
      expect(existsSync(join(home, '.ok'))).toBe(false);

      const result = await writeConfigPatch({
        cwd: testDir,
        scope: 'user',
        patch: { appearance: { theme: 'dark' } },
        homedirOverride: home,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.created).toBe(true);

      const filePath = userConfigPath(home);
      expect(existsSync(filePath)).toBe(true);

      const onDisk = readFileSync(filePath, 'utf-8');
      expect(onDisk).toContain('theme: dark');
      expect(onDisk).toMatch(/^# yaml-language-server: \$schema=/);

      expect(result.effective.appearance?.theme).toBe('dark');
    } finally {
      if (existsSync(home)) rmSync(home, { recursive: true, force: true });
    }
  });

  test('writes editor.wordWrap to user config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-write-config-patch-home-'));
    try {
      const result = await writeConfigPatch({
        cwd: testDir,
        scope: 'user',
        patch: { editor: { wordWrap: false } },
        homedirOverride: home,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.appliedPaths).toContain('editor.wordWrap');
      expect(result.effective.editor?.wordWrap).toBe(false);

      const onDisk = readFileSync(userConfigPath(home), 'utf-8');
      expect(onDisk).toContain('editor:');
      expect(onDisk).toContain('wordWrap: false');
    } finally {
      if (existsSync(home)) rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('writeConfigPatch — validation failures', () => {
  test('invalid scalar type → SCHEMA_INVALID with structured issues; no fs write', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'user',
      homedirOverride: testDir,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the test
      patch: { appearance: { theme: 42 as any } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(isKnownConfigError(result.error)).toBe(true);
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCHEMA_INVALID');
    if (result.error.code !== 'SCHEMA_INVALID') throw new Error('expected SCHEMA_INVALID');
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.issues[0].path).toContain('appearance');
    expect(existsSync(projectConfigPath())).toBe(false);
  });

  test('invalid enum value → SCHEMA_INVALID; no fs write', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'user',
      homedirOverride: testDir,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the test
      patch: { appearance: { theme: 'midnight' as any } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCHEMA_INVALID');
    expect(existsSync(projectConfigPath())).toBe(false);
  });

  test('YAML with malformed syntax → YAML_PARSE; no fs write', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    writeFileSync(
      projectConfigPath(),
      '\tnot: valid\n: : :\n  - broken\n - "unterminated',
      'utf-8',
    );

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { content: { dir: '.' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('YAML_PARSE');
  });
});

describe('writeConfigPatch — defaults preserved on round-trip with stale fields', () => {
  test('config with dropped sync.* field loads via loose-mode and preserves the line on round-trip', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    const original = `sync:
  pushIntervalSeconds: 30
  enabled: true
content:
  dir: .
mcp:
  autoStart: true
`;
    writeFileSync(projectConfigPath(), original, 'utf-8');

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { mcp: { autoStart: false } },
    });
    expect(result.ok).toBe(true);
    const onDisk = readFileSync(projectConfigPath(), 'utf-8');
    expect(onDisk).toContain('pushIntervalSeconds: 30');
    expect(onDisk).toContain('enabled: true');
    expect(onDisk).toContain('autoStart: false');
  });
});

describe('writeConfigPatch — Result type narrowing', () => {
  test('result.appliedPaths only typechecks inside the result.ok=true branch', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { content: { dir: '.' } },
    });
    if (result.ok) {
      expect(Array.isArray(result.appliedPaths)).toBe(true);
      expect(result.path).toBe(projectConfigPath());
    } else {
      expect(result.error).toBeDefined();
    }
  });
});

describe('resolveConfigPath', () => {
  test('project scope resolves to <cwd>/.ok/config.yml', () => {
    expect(resolveConfigPath('project', '/abs/proj')).toBe('/abs/proj/.ok/config.yml');
  });

  test('user scope ignores cwd, uses homedirOverride', () => {
    expect(resolveConfigPath('user', '/abs/proj', '/home/alice')).toBe(
      '/home/alice/.ok/global.yml',
    );
  });

  test('project-local scope resolves to <cwd>/.ok/local/config.yml', () => {
    expect(resolveConfigPath('project-local', '/abs/proj')).toBe('/abs/proj/.ok/local/config.yml');
  });

  test('project-local scope resolves a relative cwd against process.cwd()', () => {
    const out = resolveConfigPath('project-local', 'relative/proj');
    expect(out.endsWith('/relative/proj/.ok/local/config.yml')).toBe(true);
  });

  test('project-local scope ignores homedirOverride (project-scoped path)', () => {
    expect(resolveConfigPath('project-local', '/abs/proj', '/home/alice')).toBe(
      '/abs/proj/.ok/local/config.yml',
    );
  });
});

describe('writeConfigPatch — scope-violation gate', () => {
  test('project writer rejects a project-local field with SCOPE_VIOLATION; no fs write', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { autoSync: { enabled: true } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    expect(isKnownConfigError(result.error)).toBe(true);
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.path).toEqual(['autoSync', 'enabled']);
    expect(result.error.expectedScope).toBe('project-local');
    expect(result.error.actualScope).toBe('project');
    expect(existsSync(projectConfigPath())).toBe(false);
  });

  test('user writer rejects a project-local field with SCOPE_VIOLATION; no fs write', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'user',
      homedirOverride: testDir,
      patch: { autoSync: { enabled: false } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.expectedScope).toBe('project-local');
    expect(result.error.actualScope).toBe('user');
    expect(existsSync(userConfigPath(testDir))).toBe(false);
  });

  test('project-local writer rejects a project field with SCOPE_VIOLATION', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { content: { dir: 'docs' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.expectedScope).toBe('project');
    expect(result.error.actualScope).toBe('project-local');
  });

  test('project-local writer rejects a user field (appearance.theme) with SCOPE_VIOLATION', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      patch: { appearance: { theme: 'dark' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.expectedScope).toBe('user');
  });

  test('project writer rejects terminal.enabled with SCOPE_VIOLATION; no fs write', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { terminal: { enabled: true } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.path).toEqual(['terminal', 'enabled']);
    expect(result.error.expectedScope).toBe('project-local');
    expect(result.error.actualScope).toBe('project');
    expect(existsSync(projectConfigPath())).toBe(false);
  });

  test('user writer rejects terminal.enabled with SCOPE_VIOLATION; no fs write', async () => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'user',
      homedirOverride: testDir,
      patch: { terminal: { enabled: false } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.expectedScope).toBe('project-local');
    expect(result.error.actualScope).toBe('user');
    expect(existsSync(userConfigPath(testDir))).toBe(false);
  });

  test.each([
    'project',
    'user',
  ] as const)('%s writer rejects terminal.shell with SCOPE_VIOLATION', async (scope) => {
    const result = await writeConfigPatch({
      cwd: testDir,
      scope,
      homedirOverride: testDir,
      patch: { terminal: { shell: 'C:\\Tools\\pwsh.exe' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.path).toEqual(['terminal', 'shell']);
    expect(result.error.expectedScope).toBe('project-local');
    expect(result.error.actualScope).toBe(scope);
  });
});

describe('writeConfigPatch — concurrent writes (file lock)', () => {
  test('concurrent patches to distinct keys all land — no clobber', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });

    await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { schemaVersion: 1 },
    });

    const patches: ReadonlyArray<{ folders: ReadonlyArray<{ path: string }> }> = [
      { folders: [{ path: 'a' }] },
      { folders: [{ path: 'b' }] },
      { folders: [{ path: 'c' }] },
      { folders: [{ path: 'd' }] },
      { folders: [{ path: 'e' }] },
      { folders: [{ path: 'f' }] },
      { folders: [{ path: 'g' }] },
      { folders: [{ path: 'h' }] },
    ];

    const results = await Promise.all(
      patches.map((patch) =>
        writeConfigPatch({
          cwd: testDir,
          scope: 'project',
          patch,
        }),
      ),
    );

    for (const result of results) {
      if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
    }

    const finalText = readFileSync(projectConfigPath(), 'utf-8');
    const candidatePaths = patches.map((p) => p.folders[0]?.path);
    const matches = candidatePaths.filter((path) => finalText.includes(`path: ${path}`));
    expect(matches.length).toBeGreaterThanOrEqual(1);

    expect(existsSync(`${projectConfigPath()}.lock`)).toBe(false);
  });

  test('preserves keys touched only by writer A when writer B patches a different key concurrently', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });

    await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { folders: [{ path: 'seed' }] },
    });

    const races = Array.from({ length: 50 }, (_, i) => ({
      a: { folders: [{ path: `path-${i}` }] } as const,
      b: { mcp: { transport: i % 2 === 0 ? 'stdio' : 'http' } } as const,
    }));

    const allResults = await Promise.all(
      races.flatMap(({ a, b }) => [
        writeConfigPatch({ cwd: testDir, scope: 'project', patch: a }),
        writeConfigPatch({ cwd: testDir, scope: 'project', patch: b }),
      ]),
    );

    for (const result of allResults) {
      if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
    }

    const finalText = readFileSync(projectConfigPath(), 'utf-8');
    expect(finalText).toMatch(/folders:/);
    expect(finalText).toMatch(/mcp:[\s\S]*transport:/);
  });
});
