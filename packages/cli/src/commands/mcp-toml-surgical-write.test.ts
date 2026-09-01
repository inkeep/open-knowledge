import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTomlConfigEngine,
  setTomlConfigEngineForTesting,
} from '../native/toml-config-engine.ts';
import { CHAIN_V2, EDITOR_TARGETS, type EditorMcpTarget } from './editors.ts';
import { writeEditorMcpConfig } from './init.ts';

function codexTargetForFile(configPath: string): EditorMcpTarget {
  return { ...EDITOR_TARGETS.codex, configPath: () => configPath };
}

function writeCodex(configPath: string) {
  return writeEditorMcpConfig(codexTargetForFile(configPath), '', {
    mode: 'published',
    skipAvailabilityCheck: true,
  });
}

const PUBLISHED_CHAIN_ENTRY = { command: '/bin/sh', args: ['-l', '-c', CHAIN_V2] };

// biome-ignore lint/suspicious/noExplicitAny: structured nested access in tests.
function parseToml(raw: string): any {
  const engine = createTomlConfigEngine();
  if (engine.backend !== 'native') throw new Error('native addon required to parse');
  return engine.parseToObject(raw);
}

describe('surgical TOML MCP write', () => {
  let dir: string;

  beforeEach(() => {
    const engine = createTomlConfigEngine();
    if (engine.backend !== 'native') {
      throw new Error('native toml_edit addon must be built for the surgical TOML write gate');
    }
    setTomlConfigEngineForTesting(engine);
  });

  afterEach(() => {
    setTomlConfigEngineForTesting(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function tempFile(name: string): string {
    dir = mkdtempSync(join(tmpdir(), 'ok-toml-surgical-'));
    return join(dir, name);
  }

  it.skipIf(process.platform === 'win32')(
    'preserves a user-tightened file mode (0600) on an in-place rewrite',
    () => {
      const configPath = tempFile('config.toml');
      writeFileSync(configPath, '# my codex config\nmodel = "gpt-5"\n');
      chmodSync(configPath, 0o600);

      const result = writeCodex(configPath);
      expect(result.action).toBe('written');

      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    },
  );

  it('inserts only our entry, preserving comments, siblings, key order, and value types', () => {
    const configPath = tempFile('config.toml');
    const original = [
      '# hand-written header',
      'model = "gpt-5"',
      'approval_policy = "never"',
      'timeout = 30.0',
      'startup_timeout_ms = 9223372036854775807',
      'last_seen = 2026-06-26T12:34:56.123456Z',
      'server.host = "localhost"',
      '',
      '[mcp_servers.linear]',
      'command = "linear-cmd"  # keep this note',
      'url = "https://linear.example"',
      '',
    ].join('\n');
    writeFileSync(configPath, original);

    const result = writeCodex(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# hand-written header');
    expect(after).toContain('command = "linear-cmd"  # keep this note');
    expect(after).toContain('timeout = 30.0');
    expect(after).toContain('startup_timeout_ms = 9223372036854775807');
    expect(after).toContain('last_seen = 2026-06-26T12:34:56.123456Z');
    expect(after).toContain('server.host = "localhost"');
    expect(after).toContain('[mcp_servers.open-knowledge]');

    const parsed = parseToml(after);
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.timeout).toBe(30.0);
    expect(parsed.mcp_servers.linear).toEqual({
      command: 'linear-cmd',
      url: 'https://linear.example',
    });
    expect(parsed.mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('appends our entry with the rest of the file byte-identical (only-additive)', () => {
    const configPath = tempFile('config.toml');
    const original = '# my config\nmodel = "gpt-5"\n';
    writeFileSync(configPath, original);

    writeCodex(configPath);
    const after = readFileSync(configPath, 'utf-8');
    expect(after.startsWith(original)).toBe(true);
    expect(after.slice(original.length)).toContain('[mcp_servers.open-knowledge]');
  });

  it('preserves a leading UTF-8 BOM byte-for-byte', () => {
    const configPath = tempFile('config.toml');
    const original = '\uFEFF# bom config\nmodel = "gpt-5"\n';
    writeFileSync(configPath, original);

    const result = writeCodex(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after).toContain('# bom config');
    expect(parseToml(after).mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('preserves CRLF line endings elsewhere and keeps our chain LF-internal', () => {
    const configPath = tempFile('config.toml');
    const original =
      '# crlf config\r\nmodel = "gpt-5"\r\n\r\n[mcp_servers.other]\r\ncommand = "node"\r\n';
    writeFileSync(configPath, original);

    const result = writeCodex(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(after).toContain('# crlf config');

    const parsed = parseToml(after);
    expect(parsed.mcp_servers.other).toEqual({ command: 'node' });
    expect(parsed.mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
    const body = parsed.mcp_servers['open-knowledge'].args[2] as string;
    expect(body).toBe(CHAIN_V2);
    expect(body).not.toContain('\r');
  });

  it('does not double the CR of a CRLF multi-line string sibling', () => {
    const configPath = tempFile('config.toml');
    const original =
      '# crlf config\r\nmodel = "gpt-5"\r\n\r\n[server]\r\nnotes = """\r\nline one\r\nline two\r\n"""\r\n';
    writeFileSync(configPath, original);

    const result = writeCodex(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain('\r\r');
    expect(after).toContain('notes = """\r\nline one\r\nline two\r\n"""');
    const parsed = parseToml(after);
    expect(parsed.server.notes).toBe('line one\r\nline two\r\n');
  });

  it('keeps an LF-dominant file LF despite a stray CRLF (dominant EOL, not presence)', () => {
    const configPath = tempFile('config.toml');
    const original = 'model = "gpt-5"\r\n# one stray crlf above, rest LF\nname = "ok"\n';
    writeFileSync(configPath, original);

    const result = writeCodex(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain('\r');
    expect(parseToml(after).mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('preserves a config that lacks a trailing newline', () => {
    const configPath = tempFile('config.toml');
    const original = '# no trailing newline\nmodel = "gpt-5"';
    writeFileSync(configPath, original);

    writeCodex(configPath);
    const after = readFileSync(configPath, 'utf-8');
    expect(after.endsWith('\n')).toBe(false);
    expect(after).toContain('# no trailing newline');
    expect(parseToml(after).mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('never writes a backup sidecar beside a present, parseable config', () => {
    const configPath = tempFile('config.toml');
    const original = '# do not snapshot me\nmodel = "gpt-5"\n';
    writeFileSync(configPath, original);

    writeCodex(configPath);
    expect(existsSync(`${configPath}.ok-backup`)).toBe(false);
  });

  it('updates an existing entry in place, preserving siblings, a hand-added key, and a comment', () => {
    const configPath = tempFile('config.toml');
    const original = [
      '[mcp_servers.other]',
      'command = "other-cmd"  # sibling note',
      '',
      '[mcp_servers.open-knowledge]',
      '# interior note',
      'command = "/bin/sh"',
      'args = ["-l", "-c", "STALE"]',
      'enabled = false',
      '',
    ].join('\n');
    writeFileSync(configPath, original);

    const result = writeCodex(configPath);
    expect(result.action).toBe('overwritten');

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('command = "other-cmd"  # sibling note');
    expect(after).toContain('# interior note');
    expect(after).toContain('enabled = false');
    expect(after).not.toContain('STALE');
    const parsed = parseToml(after);
    expect(parsed.mcp_servers.other).toEqual({ command: 'other-cmd' });
    expect(parsed.mcp_servers['open-knowledge'].args).toEqual(['-l', '-c', CHAIN_V2]);
  });

  it('is a byte-identical no-op on an unchanged config (idempotent)', () => {
    const configPath = tempFile('config.toml');
    writeFileSync(configPath, '# stable\nmodel = "gpt-5"\n');

    writeCodex(configPath);
    const afterFirst = readFileSync(configPath, 'utf-8');

    const second = writeCodex(configPath);
    expect(second.action).toBe('overwritten');
    expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);
  });

  it('creates a fresh config when none exists', () => {
    const configPath = tempFile('config.toml');
    const result = writeCodex(configPath);
    expect(result.action).toBe('written');
    const after = readFileSync(configPath, 'utf-8');
    expect(after.endsWith('\n')).toBe(true);
    expect(parseToml(after).mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
    expect(existsSync(`${configPath}.ok-backup`)).toBe(false);
  });
});
