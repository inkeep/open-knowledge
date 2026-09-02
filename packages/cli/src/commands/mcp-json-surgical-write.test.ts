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
import { afterEach, describe, expect, it } from 'vitest';
import { CHAIN_V2, EDITOR_TARGETS, type EditorId, type EditorMcpTarget } from './editors.ts';
import { readExistingMcpEntry, writeEditorMcpConfig } from './init.ts';

function targetForFile(id: EditorId, configPath: string): EditorMcpTarget {
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

const PUBLISHED_CHAIN_ENTRY = { command: '/bin/sh', args: ['-l', '-c', CHAIN_V2] };
const OPENCODE_ENTRY = {
  type: 'local',
  enabled: true,
  command: ['/bin/sh', '-l', '-c', CHAIN_V2],
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
      expect(after).toContain('// hand-written header comment');
      expect(after).toContain('// inline note');
      expect(after).toContain('/* trailing block comment */');
      expect(after).toContain('"otherTopKey": 42');

      const parsed = parseConfig(after);
      const servers = parsed.mcpServers as Record<string, unknown>;
      expect(servers['existing-server']).toEqual({ command: 'node', args: ['./srv.js'] });
      expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
      expect(parsed.otherTopKey).toBe(42);
    });
  }

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
    expect(indentOfKeyLine(after, 'open-knowledge')).toBe(
      indentOfKeyLine(after, 'existing-server'),
    );
    expect(indentOfKeyLine(after, 'open-knowledge')).toBe('\t\t');
    expect(after).toContain('\t\t"existing-server"');
    const servers = parseConfig(after).mcpServers as Record<string, unknown>;
    expect(servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a user-tightened file mode (0600) on an in-place rewrite',
    () => {
      const configPath = tempFile('config.json');
      writeFileSync(configPath, '{\n  "mcpServers": {}\n}\n');
      chmodSync(configPath, 0o600);

      const result = write('claude', configPath);
      expect(result.action).toBe('written');

      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    },
  );

  it('preserves a leading UTF-8 BOM byte-for-byte', () => {
    const configPath = tempFile('config.json');
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
    const original =
      '{\r\n  // crlf header\r\n  "mcpServers": {\r\n    "existing-server": { "command": "node", "args": ["./srv.js"] }\r\n  }\r\n}\r\n';
    writeFileSync(configPath, original);

    const result = write('cursor', configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
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
    expect(after).toContain('// openclaw gateway config');
    const parsed = parseConfig(after);
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
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
    write('openclaw', configPath);
    expect(readExistingMcpEntry(target, '')).toEqual(PUBLISHED_CHAIN_ENTRY);
    writeFileSync(configPath, JSON.stringify({ mcp: { other: { command: 'x' } } }));
    expect(readExistingMcpEntry(target, '')).toBeNull();
  });

  it('openclaw: is gated on detection even under skipAvailabilityCheck (write-gate)', () => {
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

  it('updates only standard launch keys and preserves every unknown entry field', () => {
    const configPath = tempFile('config.jsonc');
    const original = `{
  "mcpServers": {
    "other": { "command": "node", "args": ["other.js"] },
    "open-knowledge": {
      "command": "/bin/sh",
      "args": ["-l", "-c", "# ok-mcp-v1\\nexit 127"],
      "env": { "KEEP": "yes" },
      "startup_timeout_ms": 45000,
      "tools": { "exec": { "approval_mode": "approve" } },
      // nested policy belongs to the harness, not OK
      "unknown": { "nested": { "values": [1, 2, 3] } }
    }
  },
  "theme": "dark"
}
`;
    writeFileSync(configPath, original);

    expect(write('cursor', configPath).action).toBe('overwritten');

    const after = readFileSync(configPath, 'utf-8');
    const entry = (parseConfig(after).mcpServers as Record<string, Record<string, unknown>>)[
      'open-knowledge'
    ];
    expect(entry).toEqual({
      ...PUBLISHED_CHAIN_ENTRY,
      env: { KEEP: 'yes' },
      startup_timeout_ms: 45000,
      tools: { exec: { approval_mode: 'approve' } },
      unknown: { nested: { values: [1, 2, 3] } },
    });
    expect(after).toContain('// nested policy belongs to the harness, not OK');
    expect(after).toContain('"other": { "command": "node", "args": ["other.js"] }');
    expect(after).toContain('"theme": "dark"');
  });

  it('updates only OpenCode launch keys without re-enabling a disabled entry', () => {
    const configPath = tempFile('opencode.json');
    writeFileSync(
      configPath,
      `{
  "mcp": {
    "open-knowledge": {
      "type": "local",
      "enabled": false,
      "command": ["/bin/sh", "-l", "-c", "# ok-mcp-v1\\nexit 127"],
      "environment": { "KEEP": "yes" },
      "unknown": { "nested": true }
    }
  }
}
`,
    );

    expect(write('opencode', configPath).action).toBe('overwritten');

    const entry = (
      parseConfig(readFileSync(configPath, 'utf-8')).mcp as Record<string, Record<string, unknown>>
    )['open-knowledge'];
    expect(entry).toEqual({
      ...OPENCODE_ENTRY,
      enabled: false,
      environment: { KEEP: 'yes' },
      unknown: { nested: true },
    });
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

    expect(existsSync(`${configPath}.ok-backup`)).toBe(false);
  });

  it('declines (oversize) and leaves the config byte-unchanged', () => {
    const configPath = tempFile('config.json');
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
