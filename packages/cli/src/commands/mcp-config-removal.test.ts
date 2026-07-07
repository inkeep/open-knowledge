import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_SERVER_NAME } from '@inkeep/open-knowledge-server';
import {
  createTomlConfigEngine,
  setTomlConfigEngineForTesting,
} from '../native/toml-config-engine.ts';
import { buildManagedServerEntry, EDITOR_TARGETS } from './editors.ts';
import { removeOwnMcpEntry } from './mcp-config-removal.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ok-mcp-remove-'));
}

// A byte-for-byte OK chain entry, JSON-embedded the way `ok init` writes it.
const OWN_ENTRY = buildManagedServerEntry({ mode: 'published' });

describe('removeOwnMcpEntry — JSON', () => {
  test('removes only OK’s entry, preserving a sibling server + its comment', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.json');
      // Comment + a foreign sibling that must survive byte-for-byte.
      const raw = `{
  // my mcp servers
  "mcpServers": {
    "other": { "command": "node", "args": ["server.js"] },
    "${MCP_SERVER_NAME}": ${JSON.stringify(OWN_ENTRY)}
  }
}
`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      const after = readFileSync(configPath, 'utf-8');
      expect(after).toContain('// my mcp servers');
      expect(after).toContain('"other"');
      expect(after).toContain('"command": "node"');
      expect(after).not.toContain(MCP_SERVER_NAME);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves the config byte-identical when OK is the only entry (empty container kept)', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.json');
      writeFileSync(
        configPath,
        `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: OWN_ENTRY } }, null, 2)}\n`,
      );
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      const after = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(after.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
      expect(after.mcpServers).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves a FOREIGN server that shares the open-knowledge key untouched', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.json');
      // A squatting / forked entry pointing elsewhere — NOT OK's managed chain.
      const foreign = { command: '/usr/bin/evil', args: ['--pwn'] };
      const raw = `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: foreign } }, null, 2)}\n`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath);
      expect(outcome.kind).toBe('left-foreign');
      // Byte-identical: a foreign server is never touched.
      expect(readFileSync(configPath, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('not-present when the config is absent or has no OK entry', () => {
    const dir = tmp();
    try {
      const missing = join(dir, 'missing.json');
      expect(removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, missing).kind).toBe(
        'not-present',
      );
      const other = join(dir, 'other.json');
      writeFileSync(other, `${JSON.stringify({ mcpServers: { other: { command: 'x' } } })}\n`);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, other).kind).toBe(
        'not-present',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('idempotent — a second removal reports not-present and does not rewrite', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.json');
      writeFileSync(
        configPath,
        `${JSON.stringify({ mcpServers: { other: { command: 'x' }, [MCP_SERVER_NAME]: OWN_ENTRY } }, null, 2)}\n`,
      );
      expect(removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath).kind).toBe(
        'removed',
      );
      const afterFirst = readFileSync(configPath, 'utf-8');
      expect(removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath).kind).toBe(
        'not-present',
      );
      expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('declines an unparseable config, leaving it byte-identical', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.json');
      const raw = '{ this is not: valid json ]';
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath);
      expect(outcome.kind).toBe('declined');
      expect(readFileSync(configPath, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes the OpenCode-shaped entry (mcp key + {type:local, command:[]})', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'opencode.json');
      const ownOpencode = EDITOR_TARGETS.opencode.buildEntry(dir);
      const raw = `${JSON.stringify({ mcp: { other: { type: 'local', command: ['x'] }, [MCP_SERVER_NAME]: ownOpencode } }, null, 2)}\n`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.opencode, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      const after = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(after.mcp[MCP_SERVER_NAME]).toBeUndefined();
      expect(after.mcp.other).toEqual({ type: 'local', command: ['x'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes OpenClaw’s nested entry at mcp.servers.open-knowledge (3-level path)', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'openclaw.json');
      const own = EDITOR_TARGETS.openclaw.buildEntry(dir);
      // OpenClaw nests servers one level deeper than the others.
      const raw = `${JSON.stringify({ mcp: { servers: { other: { command: 'x' }, [MCP_SERVER_NAME]: own } } }, null, 2)}\n`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.openclaw, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      const after = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(after.mcp.servers[MCP_SERVER_NAME]).toBeUndefined();
      expect(after.mcp.servers.other).toEqual({ command: 'x' }); // sibling preserved
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preserves a leading BOM across the removal', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'bom.json');
      const raw = `\uFEFF${JSON.stringify({ mcpServers: { other: { command: 'x' }, [MCP_SERVER_NAME]: OWN_ENTRY } }, null, 2)}\n`;
      writeFileSync(configPath, raw);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath).kind).toBe(
        'removed',
      );
      const after = readFileSync(configPath, 'utf-8');
      expect(after.charCodeAt(0)).toBe(0xfeff);
      expect(after).toContain('"other"');
      expect(after).not.toContain(MCP_SERVER_NAME);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeOwnMcpEntry — TOML (Codex)', () => {
  test('removes OK’s entry, preserving a sibling table + its comment', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.toml');
      // Build OK's entry the way init writes it, then hand-serialize a config
      // with a foreign sibling that must survive byte-for-byte.
      const chain = (OWN_ENTRY.args as string[])[2];
      const raw = `# codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "node"  # keep me\n\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/sh"\nargs = ["-l", "-c", ${JSON.stringify(chain)}]\n`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.codex, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      const after = readFileSync(configPath, 'utf-8');
      expect(after).toContain('# codex config');
      expect(after).toContain('model = "gpt-5"');
      expect(after).toContain('[mcp_servers.other]');
      expect(after).toContain('command = "node"  # keep me');
      expect(after).not.toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('idempotent — removing an already-absent Codex entry is a no-op', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.toml');
      const raw = '[mcp_servers.other]\ncommand = "node"\n';
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.codex, dir, undefined, configPath);
      expect(outcome.kind).toBe('not-present');
      expect(readFileSync(configPath, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preserves CRLF line endings across the removal', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.toml');
      const chain = (OWN_ENTRY.args as string[])[2];
      const raw = `# codex\r\n[mcp_servers.other]\r\ncommand = "node"\r\n\r\n[mcp_servers.${MCP_SERVER_NAME}]\r\ncommand = "/bin/sh"\r\nargs = ["-l", "-c", ${JSON.stringify(chain)}]\r\n`;
      writeFileSync(configPath, raw);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.codex, dir, undefined, configPath).kind).toBe(
        'removed',
      );
      const after = readFileSync(configPath, 'utf-8');
      // CRLF is preserved (toml_edit normalizes to LF; the wrapper restores it).
      expect(after.includes('\r\n')).toBe(true);
      expect(after).not.toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
      expect(after).toContain('[mcp_servers.other]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves a FOREIGN Codex entry (no OK chain sentinel) untouched', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.toml');
      const raw = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/usr/bin/evil"\nargs = ["--pwn"]\n`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.codex, dir, undefined, configPath);
      expect(outcome.kind).toBe('left-foreign');
      expect(readFileSync(configPath, 'utf-8')).toBe(raw); // byte-identical
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('declines when the format-preserving native engine is unavailable', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.toml');
      const chain = (OWN_ENTRY.args as string[])[2];
      const raw = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/sh"\nargs = ["-l", "-c", ${JSON.stringify(chain)}]\n`;
      writeFileSync(configPath, raw);
      // Force the JS fallback (no format-preserving writer) — a whole-file
      // rewrite would strip comments, so OK declines rather than degrade.
      setTomlConfigEngineForTesting(createTomlConfigEngine(() => null));
      try {
        const outcome = removeOwnMcpEntry(EDITOR_TARGETS.codex, dir, undefined, configPath);
        expect(outcome.kind).toBe('declined');
        if (outcome.kind === 'declined') expect(outcome.reason).toBe('no-native-writer');
        expect(readFileSync(configPath, 'utf-8')).toBe(raw); // byte-identical
      } finally {
        setTomlConfigEngineForTesting(null); // restore the lazy default
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
