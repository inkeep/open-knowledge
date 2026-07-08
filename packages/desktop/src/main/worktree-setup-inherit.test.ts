import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  detectRootWiredEditors,
  readRootContentDir,
  seedWorktreeProjectSetup,
} from './worktree-setup-inherit.ts';

const dirs: string[] = [];
function tmp(prefix = 'wt-setup-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

/** Write `<dir>/.ok/config.yml` with the given YAML body. */
function writeRootConfig(dir: string, body: string): void {
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), body);
}

/** Wire an editor at the root the same way OK's chain does — a project MCP
 *  config whose bytes carry the OK sentinel. `relPath` is the editor's
 *  project-scope config path. */
function wireEditorAtRoot(dir: string, relPath: string, sentinel = '# ok-mcp-v1'): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(
    abs,
    JSON.stringify({
      mcpServers: {
        'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', `${sentinel}\nexec ok mcp`] },
      },
    }),
  );
}

describe('readRootContentDir', () => {
  test('returns a non-default content.dir from the root config', () => {
    const root = tmp();
    writeRootConfig(root, 'content:\n  dir: docs\n');
    expect(readRootContentDir(root)).toBe('docs');
  });

  test('returns undefined for the default "." content.dir', () => {
    const root = tmp();
    writeRootConfig(root, 'content:\n  dir: .\n');
    expect(readRootContentDir(root)).toBeUndefined();
  });

  test('returns undefined when content.dir is absent', () => {
    const root = tmp();
    writeRootConfig(root, 'version: 1\n');
    expect(readRootContentDir(root)).toBeUndefined();
  });

  test('returns undefined (no throw) when the config is missing or unparseable', () => {
    const missing = tmp();
    expect(readRootContentDir(missing)).toBeUndefined();
    const bad = tmp();
    writeRootConfig(bad, ': : not valid yaml : :\n\t- [');
    expect(readRootContentDir(bad)).toBeUndefined();
  });
});

describe('detectRootWiredEditors', () => {
  test('detects only the editors whose project MCP config carries the OK sentinel', () => {
    const root = tmp();
    wireEditorAtRoot(root, '.mcp.json'); // claude
    wireEditorAtRoot(root, join('.cursor', 'mcp.json')); // cursor
    // codex NOT wired → excluded
    const editors = detectRootWiredEditors(root);
    expect(editors).toContain('claude');
    expect(editors).toContain('cursor');
    expect(editors).not.toContain('codex');
    // Global-only editors have no projectConfigPath and never appear.
    expect(editors).not.toContain('claude-desktop');
    expect(editors).not.toContain('openclaw');
  });

  test('accepts the Windows sentinel too', () => {
    const root = tmp();
    wireEditorAtRoot(root, '.mcp.json', '# ok-mcp-win-v1');
    expect(detectRootWiredEditors(root)).toContain('claude');
  });

  test('survives a sentinel version bump — detection keys on the version-independent prefix', () => {
    // A future `# ok-mcp-v2` / `# ok-mcp-win-v9` must still be recognized so the
    // worktree never silently loses its inherited editor wiring on a bump.
    const rootUnix = tmp();
    wireEditorAtRoot(rootUnix, '.mcp.json', '# ok-mcp-v2');
    expect(detectRootWiredEditors(rootUnix)).toContain('claude');
    const rootWin = tmp();
    wireEditorAtRoot(rootWin, '.mcp.json', '# ok-mcp-win-v9');
    expect(detectRootWiredEditors(rootWin)).toContain('claude');
  });

  test('a project config WITHOUT the sentinel (foreign tool) is not counted', () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
    expect(detectRootWiredEditors(root)).not.toContain('claude');
  });

  test('returns empty when the root has wired no project-scope editors', () => {
    const root = tmp();
    writeRootConfig(root, 'version: 1\n');
    expect(detectRootWiredEditors(root)).toEqual([]);
  });
});

describe('seedWorktreeProjectSetup', () => {
  test('materializes a valid .ok/config.yml (+ scaffold) at the worktree — the consent-dialog marker', () => {
    const root = tmp();
    const wt = tmp();
    writeRootConfig(root, 'version: 1\n');

    expect(existsSync(join(wt, '.ok', 'config.yml'))).toBe(false);
    seedWorktreeProjectSetup(wt, root);

    // The HARD GATE marker: a real, parseable config.yml at the worktree root.
    const configPath = join(wt, '.ok', 'config.yml');
    expect(existsSync(configPath)).toBe(true);
    expect(() => parseYaml(readFileSync(configPath, 'utf-8'))).not.toThrow();
    // Full `.ok/` scaffold parity with a fresh setup.
    expect(existsSync(join(wt, '.ok', '.gitignore'))).toBe(true);
    expect(existsSync(join(wt, '.okignore'))).toBe(true);
  });

  test('derives content.dir from the root config', () => {
    const root = tmp();
    const wt = tmp();
    writeRootConfig(root, 'content:\n  dir: knowledge\n');
    seedWorktreeProjectSetup(wt, root);
    const parsed = parseYaml(readFileSync(join(wt, '.ok', 'config.yml'), 'utf-8'));
    expect(parsed.content.dir).toBe('knowledge');
  });

  test('mirrors exactly the editors the root wired (writes their project MCP configs), skipping unwired editors', () => {
    const root = tmp();
    const wt = tmp();
    writeRootConfig(root, 'version: 1\n');
    wireEditorAtRoot(root, '.mcp.json'); // claude
    wireEditorAtRoot(root, join('.cursor', 'mcp.json')); // cursor

    seedWorktreeProjectSetup(wt, root);

    // Claude + Cursor mirrored to the worktree, carrying the OK sentinel.
    const wtMcp = join(wt, '.mcp.json');
    const wtCursor = join(wt, '.cursor', 'mcp.json');
    expect(existsSync(wtMcp)).toBe(true);
    expect(readFileSync(wtMcp, 'utf-8')).toContain('# ok-mcp');
    expect(existsSync(wtCursor)).toBe(true);
    // Claude also gets its launcher entry (path-independent chain).
    expect(existsSync(join(wt, '.claude', 'launch.json'))).toBe(true);
    // Codex was NOT wired at the root → not written to the worktree.
    expect(existsSync(join(wt, '.codex', 'config.toml'))).toBe(false);
  });

  test('does NOT wire any editors when the root wired none', () => {
    const root = tmp();
    const wt = tmp();
    writeRootConfig(root, 'version: 1\n');
    seedWorktreeProjectSetup(wt, root);
    expect(existsSync(join(wt, '.mcp.json'))).toBe(false);
    expect(existsSync(join(wt, '.cursor', 'mcp.json'))).toBe(false);
    // But the .ok/config.yml marker is still seeded.
    expect(existsSync(join(wt, '.ok', 'config.yml'))).toBe(true);
  });

  test('idempotent: never clobbers a config.yml already checked out by the branch (shared + committed root)', () => {
    const root = tmp();
    const wt = tmp();
    writeRootConfig(root, 'content:\n  dir: docs\n');
    // Simulate the worktree branch having already checked out a committed config.
    const committed =
      'version: 7\n# hand-authored, must survive\ncontent:\n  dir: committed-scope\n';
    mkdirSync(join(wt, '.ok'), { recursive: true });
    writeFileSync(join(wt, '.ok', 'config.yml'), committed);

    seedWorktreeProjectSetup(wt, root);

    // Byte-for-byte preserved — writeIfMissing, no clobber.
    expect(readFileSync(join(wt, '.ok', 'config.yml'), 'utf-8')).toBe(committed);
  });

  test('is safe to run twice (second run is a no-op)', () => {
    const root = tmp();
    const wt = tmp();
    writeRootConfig(root, 'version: 1\n');
    wireEditorAtRoot(root, '.mcp.json');
    seedWorktreeProjectSetup(wt, root);
    const firstConfig = readFileSync(join(wt, '.ok', 'config.yml'), 'utf-8');
    const firstMcp = readFileSync(join(wt, '.mcp.json'), 'utf-8');
    seedWorktreeProjectSetup(wt, root);
    expect(readFileSync(join(wt, '.ok', 'config.yml'), 'utf-8')).toBe(firstConfig);
    expect(readFileSync(join(wt, '.mcp.json'), 'utf-8')).toBe(firstMcp);
  });
});
