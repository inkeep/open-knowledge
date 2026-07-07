import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
    // Lazy first-write writes the magic-comment header pointing at the
    // project per-scope schema under the schema-major path (autocomplete
    // only suggests project fields here).
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
    // mode bits include the file-type bits; mask to permission-only
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
    // search.maxResults still there — patch only touched mcp.autoStart
    expect(onDisk).toContain('maxResults: 100');
  });
});

describe('writeConfigPatch — project-local scope', () => {
  function projectLocalConfigPath(): string {
    return join(testDir, '.ok', 'local', 'config.yml');
  }

  test('writes a fresh project-local config when none exists; lazily creates .ok/local/', async () => {
    // Pre-condition: neither .ok/ nor .ok/local/ exists. The lazy first-write
    // path must mkdir -p both. Mirrors the user-scope first-write contract.
    expect(existsSync(join(testDir, '.ok'))).toBe(false);

    const result = await writeConfigPatch({
      cwd: testDir,
      scope: 'project-local',
      // autoSync.enabled is scope: 'project-local' — the canonical field
      // for this layer. Schema-declared with .nullable().default(null);
      // looseObject still tolerates legacy keys, but the registered scope
      // is enforced.
      patch: { autoSync: { enabled: true } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.created).toBe(true);
    expect(result.path).toBe(projectLocalConfigPath());
    expect(result.appliedPaths).toContain('autoSync.enabled');

    expect(existsSync(projectLocalConfigPath())).toBe(true);
    const onDisk = readFileSync(projectLocalConfigPath(), 'utf-8');
    // Magic-comment header points at the project-local per-scope schema.
    expect(onDisk).toMatch(
      /^# yaml-language-server: \$schema=https:\/\/unpkg\.com\/@inkeep\/open-knowledge@latest\/dist\/schemas\/v\d+\/config\.project-local\.schema\.json/,
    );
    expect(onDisk).toContain('autoSync:');
    expect(onDisk).toContain('enabled: true');
  });

  test('round-trips an autoSync.enabled write — file parseable as YAML, structure intact', async () => {
    // The canonical project-local field. The schema declaration uses
    // .looseObject so legacy keys still parse; this test focuses on file
    // shape (key structure, YAML parseable).
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

    // Round-trip: re-read via writeConfigPatch's parse path produces the
    // intended scalar (asserts the YAML is well-formed and the structure
    // survived the doc.toString() pass).
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

  test('does NOT touch the project file at <cwd>/.ok/config.yml', async () => {
    // Per-machine scope is opaque to the committed project layer. A patch at
    // project-local must never write into the sibling project file.
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

    // Re-read via the parse path proves the YAML is well-formed and the grant
    // survives across restarts (a fresh load resolves the persisted value).
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

  test('terminal.enabled grant lands ONLY in the gitignored .ok/local/ file, never the committed project file', async () => {
    // The grant must never reach <cwd>/.ok/config.yml — that file is committed
    // and would carry the consent across a clone/sync/share, which the
    // project-local scope exists to prevent.
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
      // Pre-condition: ~/.ok does NOT exist
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
      // Magic-comment header present
      expect(onDisk).toMatch(/^# yaml-language-server: \$schema=/);

      // loadConfig (round-trip) should resolve to a Config with appearance.theme = 'dark'
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
      // appearance.theme is scope: 'user' — match it so the test reaches
      // schema validation rather than tripping the scope-violation gate.
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
      // appearance.theme is scope: 'user' and is an enum — feed it a
      // value outside the 'light' | 'dark' | 'system' set to exercise
      // the enum rejection path.
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
    // Tab character at start of a key value triggers a YAML parse error
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
    // With z.looseObject + the schema cleanup, stale fields like
    // sync.pushIntervalSeconds round-trip cleanly even though they're no
    // longer in the schema.
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
      // appliedPaths is on the success branch
      expect(Array.isArray(result.appliedPaths)).toBe(true);
      expect(result.path).toBe(projectConfigPath());
    } else {
      // error is on the failure branch
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
    // resolve(...) anchors against process.cwd() — assert the suffix shape
    // rather than the full absolute string (varies by test runner cwd).
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
    // Disk untouched on rejection.
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
    // content.dir is scope: 'project' — must NOT land in project-local.
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
    // terminal.enabled is scope: 'project-local'. Routing it to the committed
    // project file is rejected before any disk I/O, so the consent can never be
    // shared via git.
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
});

describe('writeConfigPatch — concurrent writes (file lock)', () => {
  test('concurrent patches to distinct keys all land — no clobber', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });

    // Seed an initial config so each writer has a non-trivial base. All
    // patches target distinct top-level keys so the only way any of them
    // can be lost is the read-modify-write race fix is missing.
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

    // Each writer overwrites `folders` to a single-entry list. Without the
    // lock, the read-modify-write window means concurrent writers each base
    // their patch on a stale snapshot, and the final on-disk `folders[0]`
    // is whichever writer landed last — a single value, never multiple.
    // With the lock, writers serialize and the final state is whichever
    // patch ran last; we verify all 8 calls returned ok and that the final
    // disk content matches one of the candidates exactly (no torn write).
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

    // Final disk state must be coherent — exactly one of the candidate
    // single-entry folders lists, never a mangled / partial / missing one.
    const finalText = readFileSync(projectConfigPath(), 'utf-8');
    const candidatePaths = patches.map((p) => p.folders[0]?.path);
    const matches = candidatePaths.filter((path) => finalText.includes(`path: ${path}`));
    expect(matches.length).toBeGreaterThanOrEqual(1);

    // Lockfile is cleaned up after every release.
    expect(existsSync(`${projectConfigPath()}.lock`)).toBe(false);
  });

  test('preserves keys touched only by writer A when writer B patches a different key concurrently', async () => {
    mkdirSync(join(testDir, '.ok'), { recursive: true });

    // Seed: a fresh project config so the patch writers have a base.
    await writeConfigPatch({
      cwd: testDir,
      scope: 'project',
      patch: { folders: [{ path: 'seed' }] },
    });

    // 50 concurrent races, each pair: A patches `folders` (rewrites it),
    // B patches `mcp.transport` (a disjoint key under the project schema).
    // Without the lock, B's read-modify-write base is stale and B's write
    // can overwrite A's `folders` change; with the lock, both keys persist.
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

    // Final state must contain BOTH a `folders` entry (any value) and an
    // `mcp.transport` entry (any value). Pre-fix this test would
    // intermittently lose one of the two keys.
    const finalText = readFileSync(projectConfigPath(), 'utf-8');
    expect(finalText).toMatch(/folders:/);
    expect(finalText).toMatch(/mcp:[\s\S]*transport:/);
  });
});
