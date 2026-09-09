import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_SERVER_NAME } from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import { buildPiExtensionSource } from '../integrations/pi-extension.ts';
import {
  createTomlConfigEngine,
  setTomlConfigEngineForTesting,
} from '../native/toml-config-engine.ts';
import {
  buildManagedServerEntry,
  EDITOR_TARGETS,
  PI_EXTENSION_OWNERSHIP_MARKER,
} from './editors.ts';
import { removeOwnMcpEntry } from './mcp-config-removal.ts';
import { ensurePiBridge } from './pi-acp-bridge.ts';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ok-mcp-remove-')));
}

const OWN_ENTRY = buildManagedServerEntry({ mode: 'published' });

describe('removeOwnMcpEntry — JSON', () => {
  test('removes only OK’s entry, preserving a sibling server + its comment', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.json');
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
      const foreign = { command: '/usr/bin/evil', args: ['--pwn'] };
      const raw = `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: foreign } }, null, 2)}\n`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath);
      expect(outcome.kind).toBe('left-foreign');
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
      const raw = `${JSON.stringify({ mcp: { servers: { other: { command: 'x' }, [MCP_SERVER_NAME]: own } } }, null, 2)}\n`;
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.openclaw, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      const after = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(after.mcp.servers[MCP_SERVER_NAME]).toBeUndefined();
      expect(after.mcp.servers.other).toEqual({ command: 'x' });
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
      expect(readFileSync(configPath, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('declines without the native writer, then accepts manual entry removal on retry', () => {
    const dir = tmp();
    try {
      const configPath = join(dir, 'config.toml');
      const chain = (OWN_ENTRY.args as string[])[2];
      const raw = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/sh"\nargs = ["-l", "-c", ${JSON.stringify(chain)}]\n`;
      writeFileSync(configPath, raw);
      setTomlConfigEngineForTesting(createTomlConfigEngine(() => null));
      try {
        const outcome = removeOwnMcpEntry(EDITOR_TARGETS.codex, dir, undefined, configPath);
        expect(outcome.kind).toBe('declined');
        if (outcome.kind === 'declined') expect(outcome.reason).toBe('no-native-writer');
        expect(readFileSync(configPath, 'utf-8')).toBe(raw);
        const repaired = '# user config\n[mcp_servers.other]\ncommand = "node"\n';
        writeFileSync(configPath, repaired);
        expect(removeOwnMcpEntry(EDITOR_TARGETS.codex, dir, undefined, configPath)).toEqual({
          kind: 'not-present',
        });
        expect(readFileSync(configPath, 'utf8')).toBe(repaired);
      } finally {
        setTomlConfigEngineForTesting(null);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeOwnMcpEntry — Pi managed extension file', () => {
  const piConfigPath = (dir: string) => {
    const p = EDITOR_TARGETS.pi.projectConfigPath?.(dir);
    if (!p) throw new Error('pi projectConfigPath missing');
    return p;
  };

  test('retains the bridge after trust cleanup fails and removes both on retry', async () => {
    const dir = tmp();
    const home = join(dir, 'home');
    const project = join(dir, 'project');
    try {
      const configPath = piConfigPath(project);
      const trustPath = join(home, '.pi', 'agent', 'trust.json');
      mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
      const bridge = buildPiExtensionSource();
      expect((await ensurePiBridge(project, { mode: 'published' }, home)).trust).toBe('added');
      writeFileSync(trustPath, '{malformed trust');

      expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, project, home, configPath)).toThrow(
        'bridge file was left untouched',
      );
      expect(readFileSync(configPath, 'utf8')).toBe(bridge);
      expect(readFileSync(trustPath, 'utf8')).toBe('{malformed trust');

      const otherProject = join(dir, 'other-project');
      writeFileSync(trustPath, JSON.stringify({ [project]: true, [otherProject]: true }));
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, project, home, configPath)).toEqual({
        kind: 'removed',
        trust: 'removed',
      });
      expect(existsSync(configPath)).toBe(false);
      expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({ [otherProject]: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cleans a recorded grant even when its bridge was already removed', async () => {
    const dir = tmp();
    const home = join(dir, 'home');
    const project = join(dir, 'project');
    try {
      mkdirSync(project, { recursive: true });
      const configPath = piConfigPath(project);
      expect((await ensurePiBridge(project, { mode: 'published' }, home)).trust).toBe('added');
      rmSync(configPath);

      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, project, home, configPath)).toEqual({
        kind: 'removed',
        trust: 'removed',
      });
      expect(JSON.parse(readFileSync(join(home, '.pi', 'agent', 'trust.json'), 'utf8'))).toEqual(
        {},
      );
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves unrecorded Pi trust alone when there is no bridge to remove', () => {
    const dir = tmp();
    const home = join(dir, 'home');
    const project = join(dir, 'project');
    try {
      const trustPath = join(home, '.pi', 'agent', 'trust.json');
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
      const before = '{unrelated unreadable trust config';
      writeFileSync(trustPath, before);

      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, project, home, piConfigPath(project))).toEqual({
        kind: 'not-present',
      });
      expect(readFileSync(trustPath, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps shared Pi trust while removing the bridge before other extensions', () => {
    const dir = tmp();
    const home = join(dir, 'home');
    const project = join(dir, 'project');
    try {
      const configPath = piConfigPath(project);
      const otherPath = join(project, '.pi', 'extensions', 'other.ts');
      const trustPath = join(home, '.pi', 'agent', 'trust.json');
      mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
      writeFileSync(configPath, buildPiExtensionSource());
      writeFileSync(otherPath, 'export default function extension() {}');
      const trust = JSON.stringify({ [project]: true });
      writeFileSync(trustPath, trust);

      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, project, home, configPath)).toEqual({
        kind: 'removed',
        trust: 'kept-shared',
        trustDetail: expect.any(String),
      });
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(otherPath)).toBe(true);
      expect(readFileSync(trustPath, 'utf8')).toBe(trust);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes OK’s own bridge file (current version)', () => {
    const dir = tmp();
    try {
      const configPath = piConfigPath(dir);
      mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
      writeFileSync(configPath, buildPiExtensionSource());
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.pi, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes a STALE-version drop (ownership marker is version-agnostic)', () => {
    const dir = tmp();
    try {
      const configPath = piConfigPath(dir);
      mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
      writeFileSync(configPath, `${PI_EXTENSION_OWNERSHIP_MARKER}-v0\n// legacy body\n`);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.pi, dir, undefined, configPath);
      expect(outcome.kind).toBe('removed');
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves a FOREIGN file at the managed path untouched', () => {
    const dir = tmp();
    try {
      const configPath = piConfigPath(dir);
      mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
      const raw = "// the user's own extension, not OK's\nexport default function () {}\n";
      writeFileSync(configPath, raw);
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.pi, dir, undefined, configPath);
      expect(outcome.kind).toBe('left-foreign');
      expect(readFileSync(configPath, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('not-present when the bridge file is absent, idempotent on re-run', () => {
    const dir = tmp();
    try {
      const configPath = piConfigPath(dir);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, dir, undefined, configPath).kind).toBe(
        'not-present',
      );
      mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
      writeFileSync(configPath, buildPiExtensionSource());
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, dir, undefined, configPath).kind).toBe('removed');
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, dir, undefined, configPath).kind).toBe(
        'not-present',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeOwnMcpEntry — symlinks', () => {
  test.skipIf(process.platform === 'win32')(
    'preserves an unreadable configuration target and its symlink',
    () => {
      const dir = tmp();
      try {
        const configPath = join(dir, 'config.json');
        const targetPath = join(dir, 'target.json');
        const raw = '{ malformed user settings ]';
        writeFileSync(targetPath, raw);
        symlinkSync('target.json', configPath);
        expect(removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath)).toEqual({
          kind: 'declined',
          reason: 'unparseable',
        });
        expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
        expect(readFileSync(targetPath, 'utf8')).toBe(raw);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'unlinks a managed extension file without deleting its symlink destination',
    () => {
      const dir = tmp();
      try {
        const configPath = join(dir, 'extension.ts');
        const targetPath = join(dir, 'target.ts');
        const raw = buildPiExtensionSource();
        writeFileSync(targetPath, raw);
        symlinkSync('target.ts', configPath);
        expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, dir, undefined, configPath).kind).toBe(
          'removed',
        );
        expect(existsSync(configPath)).toBe(false);
        expect(readFileSync(targetPath, 'utf8')).toBe(raw);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32').each(['claude', 'hermes', 'codex'] as const)(
    'preserves the %s config symlink chain and edits only its destination',
    (editorId) => {
      const dir = tmp();
      try {
        const configPath = join(dir, 'config');
        const targetPath = join(dir, 'dotfiles-config');
        const chain = (OWN_ENTRY.args as string[])[2];
        const raw =
          editorId === 'codex'
            ? `# user configuration\n[mcp_servers.other]\ncommand = "node"\n\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/sh"\nargs = ["-l", "-c", ${JSON.stringify(chain)}]\n`
            : editorId === 'hermes'
              ? `# user configuration\nmcp_servers:\n  other:\n    command: node\n  ${MCP_SERVER_NAME}: ${JSON.stringify(OWN_ENTRY)}\n`
              : `{\n  // user configuration\n  "mcpServers": {"other": {"command": "node"}, "${MCP_SERVER_NAME}": ${JSON.stringify(OWN_ENTRY)}}\n}\n`;
        writeFileSync(targetPath, raw, { mode: 0o640 });
        symlinkSync('dotfiles-config', join(dir, 'intermediate'));
        symlinkSync('intermediate', configPath);

        expect(removeOwnMcpEntry(EDITOR_TARGETS[editorId], dir, undefined, configPath).kind).toBe(
          'removed',
        );
        expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(configPath)).toBe('intermediate');
        expect(lstatSync(join(dir, 'intermediate')).isSymbolicLink()).toBe(true);
        const after = readFileSync(targetPath, 'utf8');
        expect(after).toContain('user configuration');
        expect(after).toContain('other');
        expect(after).not.toContain(MCP_SERVER_NAME);
        expect(statSync(targetPath).mode & 0o777).toBe(0o640);
        expect(removeOwnMcpEntry(EDITOR_TARGETS[editorId], dir, undefined, configPath).kind).toBe(
          'not-present',
        );
        expect(readFileSync(targetPath, 'utf8')).toBe(after);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32').each(['dangling', 'cycle'])(
    'declines a %s config symlink without removing it',
    (kind) => {
      const dir = tmp();
      try {
        const configPath = join(dir, 'config.json');
        symlinkSync(kind === 'cycle' ? 'config.json' : 'missing.json', configPath);
        expect(removeOwnMcpEntry(EDITOR_TARGETS.claude, dir, undefined, configPath)).toEqual({
          kind: 'declined',
          reason: kind === 'cycle' ? 'unresolved-symlink' : 'missing-symlink-target',
        });
        expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
        expect(existsSync(join(dir, 'missing.json'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
