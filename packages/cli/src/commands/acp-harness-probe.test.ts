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

    // Foreign command — never stand down for a server that isn't ours.
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': { command: 'evil', args: [] } },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();

    // Canonical command but tampered args — a different chain body, not ours.
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', 'rm -rf /'] } },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();

    // Unparseable config — never throws, counts as a miss.
    writeFileSync(join(cwd, '.mcp.json'), '{not json');
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)).toBeNull();
  });

  test('hits when the canonical entry carries harness policy siblings (an env overlay)', () => {
    const cwd = tmp();
    const home = tmp();
    // command+args are OK's canonical chain → the harness launches OK's server
    // regardless of the extra `env` key, so we still skip injecting a duplicate.
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { 'open-knowledge': { ...publishedEntry(), env: { X: '1' } } },
    });
    expect(probeOwnManagedEditorMcpEntry('claude', cwd, home)?.scope).toBe('project');
  });

  test("hits despite Codex's churny per-tool approval policy (the tools subtable)", () => {
    const cwd = tmp();
    const home = tmp();
    // Exactly the shape Codex writes as the user approves tools mid-session:
    // `[mcp_servers.open-knowledge.tools.exec] approval_mode = "approve"` parses
    // to a `tools` key on the entry. It must NOT break the match.
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
    // A hypothetical bumped chain (`# ok-mcp-v2`) an existing install would
    // carry after we ship a new CHAIN — must still count as ours, or the
    // duplicate-injection collision resurfaces until everyone re-runs `ok init`.
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

    // Disabled entry means the harness will NOT load it — keep injecting.
    writeJson(join(cwd, 'opencode.json'), {
      mcp: { 'open-knowledge': { ...openCodePublished(), enabled: false } },
    });
    expect(probeOwnManagedEditorMcpEntry('opencode', cwd, home)).toBeNull();

    // Chain-shape (split command/args) inside opencode's config is foreign.
    writeJson(join(cwd, 'opencode.json'), {
      mcp: { 'open-knowledge': publishedEntry() },
    });
    expect(probeOwnManagedEditorMcpEntry('opencode', cwd, home)).toBeNull();
  });
});

describe('entryRunsOwnManagedServer', () => {
  test('matches OK chain shapes by marker, ignoring policy siblings', () => {
    expect(entryRunsOwnManagedServer(publishedEntry())).toBe(true);
    // Version bump: a future body still carries the stable marker → hit.
    expect(
      entryRunsOwnManagedServer({ command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v9\nexec x'] }),
    ).toBe(true);
    // Windows chain shape.
    expect(
      entryRunsOwnManagedServer({
        command: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', '# ok-mcp-win-v1\nexit 0'],
      }),
    ).toBe(true);
    // Churny/benign siblings don't change what runs → hit.
    expect(entryRunsOwnManagedServer({ ...publishedEntry(), env: { X: '1' } })).toBe(true);
    expect(
      entryRunsOwnManagedServer({
        ...publishedEntry(),
        tools: { exec: { approval_mode: 'approve' } },
      }),
    ).toBe(true);
  });

  test('misses disabled, foreign, and non-chain entries', () => {
    // Explicitly disabled → the harness will not load it → inject.
    expect(entryRunsOwnManagedServer({ ...publishedEntry(), enabled: false })).toBe(false);
    // Right interpreter + flags but a body without the marker → foreign.
    expect(entryRunsOwnManagedServer({ command: '/bin/sh', args: ['-l', '-c', 'rm -rf /'] })).toBe(
      false,
    );
    // Foreign interpreter → miss.
    expect(entryRunsOwnManagedServer({ command: 'evil', args: [] })).toBe(false);
    // Wrong flag prefix even with the marker in the body → miss.
    expect(entryRunsOwnManagedServer({ command: '/bin/sh', args: ['-c', '# ok-mcp-v1'] })).toBe(
      false,
    );
    expect(entryRunsOwnManagedServer(null)).toBe(false);
  });
});

describe('openCodeEntryRunsOwnManagedServer', () => {
  test('matches on identity (type + enabled + argv), ignoring policy siblings', () => {
    expect(openCodeEntryRunsOwnManagedServer(openCodePublished())).toBe(true);
    // enabled: false → the harness will not load it → does not cover us.
    expect(openCodeEntryRunsOwnManagedServer({ ...openCodePublished(), enabled: false })).toBe(
      false,
    );
    // An extra `environment` sibling doesn't change which server runs → hit.
    expect(
      openCodeEntryRunsOwnManagedServer({ ...openCodePublished(), environment: { X: '1' } }),
    ).toBe(true);
    // Foreign argv → miss.
    expect(
      openCodeEntryRunsOwnManagedServer({
        type: 'local',
        enabled: true,
        command: ['/bin/sh', '-c', 'x'],
      }),
    ).toBe(false);
    // Chain-shape (wrong envelope) → miss.
    expect(openCodeEntryRunsOwnManagedServer(buildManagedServerEntry({ mode: 'published' }))).toBe(
      false,
    );
    expect(openCodeEntryRunsOwnManagedServer(null)).toBe(false);
  });
});
