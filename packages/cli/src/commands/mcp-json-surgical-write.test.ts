import { afterEach, describe, expect, it } from 'bun:test';
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
import { dirname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { CHAIN_V1, EDITOR_TARGETS, type EditorId, type EditorMcpTarget } from './editors.ts';
import { readExistingMcpEntry, writeEditorMcpConfig } from './init.ts';

// Redirect a real editor target at a temp file so the surgical write path runs
// against its actual container key + entry builder without runInit's project
// side effects.
function targetForFile(id: EditorId, configPath: string): EditorMcpTarget {
  // Point detectPath at the temp dir (which exists) so `offerOnlyWhenDetected`
  // editors (OpenClaw) clear the write-gate in these format-preservation tests.
  return {
    ...EDITOR_TARGETS[id],
    configPath: () => configPath,
    detectPath: () => dirname(configPath),
  };
}

function write(id: EditorId, configPath: string) {
  return writeEditorMcpConfig(targetForFile(id, configPath), '', {
    mode: 'published',
    skipAvailabilityCheck: true,
  });
}

const PUBLISHED_CHAIN_ENTRY = { command: '/bin/sh', args: ['-l', '-c', CHAIN_V1] };
const OPENCODE_ENTRY = {
  type: 'local',
  enabled: true,
  command: ['/bin/sh', '-l', '-c', CHAIN_V1],
};

function parseConfig(raw: string): Record<string, unknown> {
  return parseJsonc(raw, [], { allowTrailingComma: true, disallowComments: false }) as Record<
    string,
    unknown
  >;
}

describe('surgical JSON MCP write', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  function tempFile(name: string): string {
    dir = mkdtempSync(join(tmpdir(), 'ok-surgical-'));
    return join(dir, name);
  }

  // claude / claude-desktop / cursor share the `mcpServers` container + chain
  // entry shape; one parameterized fixture covers all three real shapes.
  for (const id of ['claude', 'claude-desktop', 'cursor'] as const) {
    it(`${id}: inserts only our entry, preserving comments, siblings, and key order`, () => {
      const configPath = tempFile('config.json');
      const original = `{
  // hand-written header comment
  "mcpServers": {
    "existing-server": {
      "command": "node",
      "args": ["./srv.js"] // inline note
    }
  },
  /* trailing block comment */
  "otherTopKey": 42
}
`;
      writeFileSync(configPath, original);

      const result = write(id, configPath);
      expect(result.action).toBe('written');

      const after = readFileSync(configPath, 'utf-8');
      // Comments and the unrelated top-level key survive byte-for-byte.
      expect(after).toContain('// hand-written header comment');
      expect(after).toContain('// inline note');
      expect(after).toContain('/* trailing block comment */');
      expect(after).toContain('"otherTopKey": 42');

      // Independent parse confirms data-equality: sibling untouched, our entry added.
      const parsed = parseConfig(after);
      const servers = parsed.mcpServers as Record<string, unknown>;
      expect(servers['existing-server']).toEqual({ command: 'node', args: ['./srv.js'] });
      expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
      expect(parsed.otherTopKey).toBe(42);
    });
  }

  // Leading whitespace of the first line mentioning `"<key>"` — the oracle for
  // "OK's inserted block matches the file's indentation convention."
  function indentOfKeyLine(text: string, key: string): string {
    const line = text.split('\n').find((l) => l.includes(`"${key}"`));
    if (line === undefined) throw new Error(`key "${key}" not found in output`);
    return line.slice(0, line.length - line.trimStart().length);
  }

  it('matches a 4-space-indented config (does not force 2-space on our entry)', () => {
    const configPath = tempFile('config.json');
    const original = [
      '{',
      '    "mcpServers": {',
      '        "existing-server": {',
      '            "command": "node"',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    writeFileSync(configPath, original);

    const result = write('cursor', configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    // Our entry's key lands at the same indentation as the existing sibling —
    // both depth-2 keys, so both 8 spaces in a 4-space file.
    expect(indentOfKeyLine(after, 'open-knowledge')).toBe(
      indentOfKeyLine(after, 'existing-server'),
    );
    expect(indentOfKeyLine(after, 'open-knowledge')).toBe('        ');
    const servers = parseConfig(after).mcpServers as Record<string, unknown>;
    expect(servers['existing-server']).toEqual({ command: 'node' });
    expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('matches a tab-indented config (does not force spaces on our entry)', () => {
    const configPath = tempFile('config.json');
    const original = ['{', '\t"mcpServers": {', '\t\t"existing-server": {}', '\t}', '}', ''].join(
      '\n',
    );
    writeFileSync(configPath, original);

    const result = write('cursor', configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    // Our entry's key is tab-indented to match the sibling (depth-2 → two tabs).
    expect(indentOfKeyLine(after, 'open-knowledge')).toBe(
      indentOfKeyLine(after, 'existing-server'),
    );
    expect(indentOfKeyLine(after, 'open-knowledge')).toBe('\t\t');
    // Only-additive: the sibling's own tab indentation is left byte-unchanged —
    // a mismatched indent unit would make jsonc-parser retype it to spaces.
    expect(after).toContain('\t\t"existing-server"');
    const servers = parseConfig(after).mcpServers as Record<string, unknown>;
    expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a user-tightened file mode (0600) on an in-place rewrite',
    () => {
      const configPath = tempFile('config.json');
      writeFileSync(configPath, '{\n  "mcpServers": {}\n}\n');
      // A user who chmod 600'd a config to protect sibling MCP servers' tokens
      // must not have it silently widened to group/world-readable on rewrite.
      chmodSync(configPath, 0o600);

      const result = write('claude', configPath);
      expect(result.action).toBe('written');

      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    },
  );

  it('preserves a leading UTF-8 BOM byte-for-byte', () => {
    const configPath = tempFile('config.json');
    // Explicit escape — keep the BOM out of the source as an invisible literal.
    const original = `\uFEFF{
  // keep me
  "mcpServers": {}
}
`;
    writeFileSync(configPath, original);

    const result = write('claude', configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after).toContain('// keep me');
    const parsed = parseConfig(after);
    expect((parsed.mcpServers as Record<string, unknown>)['open-knowledge']).toEqual(
      PUBLISHED_CHAIN_ENTRY,
    );
  });

  it('preserves CRLF line endings on untouched lines and inserts our entry as CRLF', () => {
    const configPath = tempFile('config.json');
    // A uniformly-CRLF config (Windows default): every newline is CRLF.
    const original =
      '{\r\n  // crlf header\r\n  "mcpServers": {\r\n    "existing-server": { "command": "node", "args": ["./srv.js"] }\r\n  }\r\n}\r\n';
    writeFileSync(configPath, original);

    const result = write('cursor', configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    // No bare LF leaked in: stripping every CRLF leaves no lone '\n'.
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(after).toContain('// crlf header');

    const servers = parseConfig(after).mcpServers as Record<string, unknown>;
    expect(servers['existing-server']).toEqual({ command: 'node', args: ['./srv.js'] });
    expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('opencode: inserts the array-command entry under `mcp`, preserving comments + siblings', () => {
    const configPath = tempFile('opencode.json');
    const original = `{
  // opencode config
  "mcp": {
    "other": { "type": "local", "enabled": true, "command": ["node", "x.js"] }
  }
}
`;
    writeFileSync(configPath, original);

    const result = write('opencode', configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('// opencode config');
    const parsed = parseConfig(after);
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.other).toEqual({ type: 'local', enabled: true, command: ['node', 'x.js'] });
    expect(mcp['open-knowledge']).toEqual(OPENCODE_ENTRY);
  });

  it('openclaw: inserts the nested entry under `mcp.servers`, preserving comments + siblings', () => {
    const configPath = tempFile('openclaw.json');
    const original = `{
  // openclaw gateway config
  "mcp": {
    "servers": {
      "other": { "command": "node", "args": ["x.js"] }
    }
  },
  "gateway": { "port": 8080 }
}
`;
    writeFileSync(configPath, original);

    const result = write('openclaw', configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    // The comment and the unrelated top-level key survive byte-for-byte.
    expect(after).toContain('// openclaw gateway config');
    const parsed = parseConfig(after);
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    // Sibling under `mcp.servers` untouched, our entry added alongside it.
    expect(mcp.servers.other).toEqual({ command: 'node', args: ['x.js'] });
    expect(mcp.servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
    expect(parsed.gateway).toEqual({ port: 8080 });
  });

  it('openclaw: builds the nested `mcp.servers` container when the config is absent', () => {
    const configPath = tempFile('openclaw.json');
    const result = write('openclaw', configPath);
    expect(result.action).toBe('written');
    const mcp = parseConfig(readFileSync(configPath, 'utf-8')).mcp as Record<
      string,
      Record<string, unknown>
    >;
    expect(mcp.servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('openclaw: classify reads our nested entry back, and is no-entry when `servers` is absent', () => {
    const configPath = tempFile('openclaw.json');
    const target = targetForFile('openclaw', configPath);
    // Present: the nested `mcp.servers.<name>` entry is read back through the classifier.
    write('openclaw', configPath);
    expect(readExistingMcpEntry(target, '')).toEqual(PUBLISHED_CHAIN_ENTRY);
    // No-entry: `mcp` exists but without a `servers` map — the nested walk stops short.
    writeFileSync(configPath, JSON.stringify({ mcp: { other: { command: 'x' } } }));
    expect(readExistingMcpEntry(target, '')).toBeNull();
  });

  it('openclaw: is gated on detection even under skipAvailabilityCheck (write-gate)', () => {
    // OpenClaw is `offerOnlyWhenDetected`: when its config root is absent it is
    // never written, even in the consent flow that otherwise bypasses the
    // availability check. No `~/.openclaw` => no config for a tool that isn't there.
    const configPath = tempFile('openclaw.json');
    const target: EditorMcpTarget = {
      ...EDITOR_TARGETS.openclaw,
      configPath: () => configPath,
      detectPath: () => join(dirname(configPath), 'no-such-openclaw-root'),
    };
    const result = writeEditorMcpConfig(target, '', {
      mode: 'published',
      skipAvailabilityCheck: true,
    });
    expect(result.action).toBe('skipped-missing');
    expect(existsSync(configPath)).toBe(false);
  });

  it('openclaw: updating our nested entry rewrites only our slot', () => {
    const configPath = tempFile('openclaw.json');
    writeFileSync(
      configPath,
      `{
  "mcp": {
    "servers": {
      "keep": { "command": "node", "args": ["keep.js"] },
      "open-knowledge": { "command": "stale", "args": ["old"] }
    }
  }
}
`,
    );
    const result = write('openclaw', configPath);
    expect(result.action).toBe('overwritten');
    const mcp = parseConfig(readFileSync(configPath, 'utf-8')).mcp as Record<
      string,
      Record<string, unknown>
    >;
    expect(mcp.servers.keep).toEqual({ command: 'node', args: ['keep.js'] });
    expect(mcp.servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('updating an existing entry rewrites only our slot, leaving siblings intact', () => {
    const configPath = tempFile('config.json');
    const original = `{
  // header
  "mcpServers": {
    "existing-server": { "command": "node", "args": ["./srv.js"] },
    "open-knowledge": { "command": "stale", "args": ["old"] }
  }
}
`;
    writeFileSync(configPath, original);

    const result = write('cursor', configPath);
    expect(result.action).toBe('overwritten');

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('// header');
    const servers = parseConfig(after).mcpServers as Record<string, unknown>;
    expect(servers['existing-server']).toEqual({ command: 'node', args: ['./srv.js'] });
    expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('is a byte-identical no-op when our entry is already current', () => {
    const configPath = tempFile('config.json');
    writeFileSync(
      configPath,
      `{
  // comment to preserve
  "mcpServers": {}
}
`,
    );
    const first = write('claude', configPath);
    expect(first.action).toBe('written');
    const afterFirst = readFileSync(configPath, 'utf-8');

    const second = write('claude', configPath);
    expect(second.action).toBe('overwritten');
    expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);
  });

  it('never writes a backup sidecar beside a present, parseable config', () => {
    const configPath = tempFile('config.json');
    const original = `{
  // original
  "mcpServers": { "existing-server": { "command": "node" } }
}
`;
    writeFileSync(configPath, original);

    write('cursor', configPath);

    // No `.ok-backup` sidecar: a whole-file copy beside the (possibly git-tracked,
    // symlink-resolved) target would snapshot sibling MCP servers' secrets; the
    // atomic tmp+rename already guards against a torn write.
    expect(existsSync(`${configPath}.ok-backup`)).toBe(false);
  });

  it('declines (oversize) and leaves the config byte-unchanged', () => {
    const configPath = tempFile('config.json');
    // Valid JSON, present, but past the 10 MiB rewrite bound.
    const huge = 'x'.repeat(11 * 1024 * 1024);
    const original = `{ "mcpServers": { "big": { "note": "${huge}" } } }`;
    writeFileSync(configPath, original);

    const result = write('claude', configPath);
    expect(result.action).toBe('declined');
    expect(result.declineReason).toBe('oversize');
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(existsSync(`${configPath}.ok-backup`)).toBe(false);
  });

  it('declines (duplicate-container) rather than editing one block arbitrarily', () => {
    const configPath = tempFile('config.json');
    const original = `{
  "mcpServers": { "a": { "command": "x" } },
  "mcpServers": { "b": { "command": "y" } }
}
`;
    writeFileSync(configPath, original);

    const result = write('claude', configPath);
    expect(result.action).toBe('declined');
    expect(result.declineReason).toBe('duplicate-container');
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('creates a fresh config when the file is absent', () => {
    const configPath = tempFile('config.json');
    const result = write('cursor', configPath);
    expect(result.action).toBe('written');
    const servers = parseConfig(readFileSync(configPath, 'utf-8')).mcpServers as Record<
      string,
      unknown
    >;
    expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });
});
