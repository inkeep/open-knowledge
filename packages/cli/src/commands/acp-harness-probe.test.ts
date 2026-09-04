import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, test } from 'vitest';
import { probeOwnManagedEditorMcpEntry } from './acp-harness-probe.ts';
import {
  buildManagedServerEntry,
  CHAIN_V2,
  entryRunsOwnManagedServer,
  openCodeEntryRunsOwnManagedServer,
} from './editors.ts';

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-harness-probe-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

const publishedEntry = () => buildManagedServerEntry({ mode: 'published' });

const openCodePublished = () => ({
  type: 'local',
  enabled: true,
  command: ['/bin/sh', '-l', '-c', CHAIN_V2],
});

describe('probeOwnManagedEditorMcpEntry', () => {
  test('hits the claude project .mcp.json before the user config', () => {
    const cwd = tmp();
    const home = tmp();
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': publishedEntry() },
    });
    writeJson(join(home, '.claude.json'), {
      mcpServers: { 'open-knowledge': publishedEntry() },
    });
    const hit = probeOwnManagedEditorMcpEntry('claude', cwd, home);
    expect(hit).toEqual({
      editorId: 'claude',
      scope: 'project',
      configPath: join(cwd, '.mcp.json'),
    });
  });

  test('falls back to the user-global claude config when the project has none', () => {
    const cwd = tmp();
    const home = tmp();
    writeJson(join(home, '.claude.json'), {
      mcpServers: { 'open-knowledge': publishedEntry() },
    });
    const hit = probeOwnManagedEditorMcpEntry('claude', cwd, home);
    expect(hit).toEqual({
      editorId: 'claude',
      scope: 'user',
      configPath: join(home, '.claude.json'),
    });
  });

  test('misses on absent configs and foreign command/args', () => {
    const cwd = tmp();
    const home = tmp();
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();

    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': { command: 'evil', args: [] } },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();

    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', 'rm -rf /'] } },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();

    writeFileSync(join(cwd, '.mcp.json'), '{not json');
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();
  });

  test('hits when the canonical entry carries harness policy siblings (an env overlay)', () => {
    const cwd = tmp();
    const home = tmp();
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': { ...publishedEntry(), env: { X: '1' } } },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)?.scope).toBe('project');
  });

  test("hits despite Codex's churny per-tool approval policy (the tools subtable)", () => {
    const cwd = tmp();
    const home = tmp();
    mkdirSync(join(cwd, '.codex'), { recursive: true });
    writeFileSync(
      join(cwd, '.codex', 'config.toml'),
      stringifyToml({
        mcp_servers: {
          'open-knowledge': {
            ...publishedEntry(),
            tools: { exec: { approval_mode: 'approve' } },
          },
        },
      }),
    );
    expect(probeOwnManagedEditorMcpEntry('codex', cwd, home)).toEqual({
      editorId: 'codex',
      scope: 'project',
      configPath: join(cwd, '.codex', 'config.toml'),
    });
  });

  test('reads the codex TOML config on both scopes', () => {
    const cwd = tmp();
    const home = tmp();
    mkdirSync(join(cwd, '.codex'), { recursive: true });
    writeFileSync(
      join(cwd, '.codex', 'config.toml'),
      stringifyToml({ mcp_servers: { 'open-knowledge': publishedEntry() } }),
    );
    expect(probeOwnManagedEditorMcpEntry('codex', cwd, home)).toEqual({
      editorId: 'codex',
      scope: 'project',
      configPath: join(cwd, '.codex', 'config.toml'),
    });

    const cwd2 = tmp();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      stringifyToml({ mcp_servers: { 'open-knowledge': publishedEntry() } }),
    );
    expect(probeOwnManagedEditorMcpEntry('codex', cwd2, home)).toEqual({
      editorId: 'codex',
      scope: 'user',
      configPath: join(home, '.codex', 'config.toml'),
    });
  });

  test('hits the cursor project config', () => {
    const cwd = tmp();
    const home = tmp();
    writeJson(join(cwd, '.cursor', 'mcp.json'), {
      mcpServers: { 'open-knowledge': publishedEntry() },
    });
    expect(probeOwnManagedEditorMcpEntry('cursor', cwd, home)?.scope).toBe('project');
  });

  test('version-proof: hits a future chain body carrying the ok-mcp marker', () => {
    const cwd = tmp();
    const home = tmp();
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: {
        'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v2\nexec foo mcp'] },
      },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)?.scope).toBe('project');
  });

  test('misses an explicitly disabled same-named entry (harness will not load it)', () => {
    const cwd = tmp();
    const home = tmp();
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': { ...publishedEntry(), enabled: false } },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();
  });

  test('opencode: hits the enabled published envelope, misses disabled/foreign', () => {
    const cwd = tmp();
    const home = tmp();
    writeJson(join(cwd, 'opencode.json'), {
      mcp: { 'open-knowledge': openCodePublished() },
    });
    expect(probeOwnManagedEditorMcpEntry('opencode', cwd, home)).toEqual({
      editorId: 'opencode',
      scope: 'project',
      configPath: join(cwd, 'opencode.json'),
    });

    writeJson(join(cwd, 'opencode.json'), {
      mcp: { 'open-knowledge': { ...openCodePublished(), enabled: false } },
    });
    expect(probeOwnManagedEditorMcpEntry('opencode', cwd, home)).toBeNull();

    writeJson(join(cwd, 'opencode.json'), {
      mcp: { 'open-knowledge': publishedEntry() },
    });
    expect(probeOwnManagedEditorMcpEntry('opencode', cwd, home)).toBeNull();
  });
});

describe('entryRunsOwnManagedServer', () => {
  test('matches OK chain shapes by marker, ignoring policy siblings', () => {
    expect(entryRunsOwnManagedServer(publishedEntry())).toBe(true);
    expect(
      entryRunsOwnManagedServer({ command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v9\nexec x'] }),
    ).toBe(true);
    expect(
      entryRunsOwnManagedServer({
        command: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', '# ok-mcp-win-v1\nexit 0'],
      }),
    ).toBe(true);
    expect(entryRunsOwnManagedServer({ ...publishedEntry(), env: { X: '1' } })).toBe(true);
    expect(
      entryRunsOwnManagedServer({
        ...publishedEntry(),
        tools: { exec: { approval_mode: 'approve' } },
      }),
    ).toBe(true);
  });

  test('misses disabled, foreign, and non-chain entries', () => {
    expect(entryRunsOwnManagedServer({ ...publishedEntry(), enabled: false })).toBe(false);
    expect(entryRunsOwnManagedServer({ command: '/bin/sh', args: ['-l', '-c', 'rm -rf /'] })).toBe(
      false,
    );
    expect(entryRunsOwnManagedServer({ command: 'evil', args: [] })).toBe(false);
    expect(entryRunsOwnManagedServer({ command: '/bin/sh', args: ['-c', '# ok-mcp-v1'] })).toBe(
      false,
    );
    expect(entryRunsOwnManagedServer(null)).toBe(false);
  });
});

describe('openCodeEntryRunsOwnManagedServer', () => {
  test('matches on identity (type + enabled + argv), ignoring policy siblings', () => {
    expect(openCodeEntryRunsOwnManagedServer(openCodePublished())).toBe(true);
    expect(openCodeEntryRunsOwnManagedServer({ ...openCodePublished(), enabled: false })).toBe(
      false,
    );
    expect(
      openCodeEntryRunsOwnManagedServer({ ...openCodePublished(), environment: { X: '1' } }),
    ).toBe(true);
    expect(
      openCodeEntryRunsOwnManagedServer({
        type: 'local',
        enabled: true,
        command: ['/bin/sh', '-c', 'x'],
      }),
    ).toBe(false);
    expect(openCodeEntryRunsOwnManagedServer(buildManagedServerEntry({ mode: 'published' }))).toBe(
      false,
    );
    expect(openCodeEntryRunsOwnManagedServer(null)).toBe(false);
  });
});
