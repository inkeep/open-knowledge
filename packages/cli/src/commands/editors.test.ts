import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  buildCopilotServerEntry,
  buildManagedServerEntry,
  CHAIN_V1,
  CHAIN_VERSION_SENTINEL,
  type EditorId,
  isEntryUpToDate,
  resolveAppSupportPath,
  resolveClaudeCodeConfigPath,
  resolveClaudeDesktopConfigPath,
  resolveCodexConfigPath,
  resolveCopilotCliConfigPath,
  resolveCursorConfigPath,
  resolveEditorTargets,
} from './editors.ts';

describe('resolveAppSupportPath', () => {
  it('uses macOS Application Support under home', () => {
    expect(resolveAppSupportPath({ home: '/Users/alice', platformName: 'darwin' })).toBe(
      '/Users/alice/Library/Application Support',
    );
  });

  it('uses APPDATA on Windows when available', () => {
    expect(
      resolveAppSupportPath({
        home: 'C:\\Users\\Alice',
        platformName: 'win32',
        env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' },
      }),
    ).toBe('C:\\Users\\Alice\\AppData\\Roaming');
  });

  it('falls back to AppData/Roaming on Windows when APPDATA is absent', () => {
    expect(
      resolveAppSupportPath({
        home: 'C:\\Users\\Alice',
        platformName: 'win32',
        env: {},
      }),
    ).toBe('C:\\Users\\Alice\\AppData\\Roaming');
  });

  it('uses XDG_CONFIG_HOME on Linux when available', () => {
    expect(
      resolveAppSupportPath({
        home: '/home/alice',
        platformName: 'linux',
        env: { XDG_CONFIG_HOME: '/tmp/xdg-config' },
      }),
    ).toBe('/tmp/xdg-config');
  });

  it('falls back to ~/.config on Linux when XDG_CONFIG_HOME is absent', () => {
    expect(resolveAppSupportPath({ home: '/home/alice', platformName: 'linux', env: {} })).toBe(
      '/home/alice/.config',
    );
  });
});

describe('resolveClaudeDesktopConfigPath', () => {
  it('builds the macOS config path', () => {
    expect(
      resolveClaudeDesktopConfigPath({
        home: '/Users/alice',
        platformName: 'darwin',
      }),
    ).toBe('/Users/alice/Library/Application Support/Claude/claude_desktop_config.json');
  });

  it('builds the Windows config path', () => {
    expect(
      resolveClaudeDesktopConfigPath({
        home: 'C:\\Users\\Alice',
        platformName: 'win32',
        env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' },
      }),
    ).toBe('C:\\Users\\Alice\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  });

  it('rejects unsupported platforms', () => {
    expect(() =>
      resolveClaudeDesktopConfigPath({
        home: '/home/alice',
        platformName: 'linux',
        env: { XDG_CONFIG_HOME: '/home/alice/.config' },
      }),
    ).toThrow(/Claude Desktop is not available on linux\. Supported: macOS, Windows\./);
  });
});

describe('resolveClaudeCodeConfigPath', () => {
  it('builds the macOS config path', () => {
    expect(
      resolveClaudeCodeConfigPath({
        home: '/Users/alice',
        platformName: 'darwin',
      }),
    ).toBe('/Users/alice/.claude.json');
  });

  it('builds the Windows config path', () => {
    expect(
      resolveClaudeCodeConfigPath({
        home: 'C:\\Users\\Alice',
        platformName: 'win32',
      }),
    ).toBe('C:\\Users\\Alice\\.claude.json');
  });
});

describe('resolveCursorConfigPath', () => {
  it('builds the global Cursor config path', () => {
    expect(
      resolveCursorConfigPath({
        home: '/Users/alice',
        platformName: 'darwin',
      }),
    ).toBe('/Users/alice/.cursor/mcp.json');
  });
});

describe('resolveCodexConfigPath', () => {
  it('builds the default Codex config path', () => {
    expect(
      resolveCodexConfigPath({
        home: '/Users/alice',
        platformName: 'darwin',
        env: {},
      }),
    ).toBe('/Users/alice/.codex/config.toml');
  });

  it('honors CODEX_HOME when present', () => {
    expect(
      resolveCodexConfigPath({
        home: '/Users/alice',
        platformName: 'darwin',
        env: { CODEX_HOME: '/tmp/custom-codex-home' },
      }),
    ).toBe('/tmp/custom-codex-home/config.toml');
  });
});

describe('resolveCopilotCliConfigPath', () => {
  it('builds the default Copilot CLI config path', () => {
    expect(
      resolveCopilotCliConfigPath({
        home: '/Users/alice',
        platformName: 'darwin',
        env: {},
      }),
    ).toBe('/Users/alice/.copilot/mcp-config.json');
  });

  it('honors COPILOT_HOME when present', () => {
    expect(
      resolveCopilotCliConfigPath({
        home: '/Users/alice',
        platformName: 'darwin',
        env: { COPILOT_HOME: '/tmp/custom-copilot-home' },
      }),
    ).toBe('/tmp/custom-copilot-home/mcp-config.json');
  });
});

describe('CHAIN_V1', () => {
  it('starts with the version sentinel', () => {
    expect(CHAIN_V1.startsWith(CHAIN_VERSION_SENTINEL)).toBe(true);
  });

  it('probes user-local install before the system bundle path', () => {
    const userIdx = CHAIN_V1.indexOf(
      'USER_BUNDLE="$HOME/Applications/Open Knowledge.app/Contents/Resources/cli/bin/ok.sh"',
    );
    const sysIdx = CHAIN_V1.indexOf(
      'BUNDLE="/Applications/Open Knowledge.app/Contents/Resources/cli/bin/ok.sh"',
    );
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(sysIdx).toBeGreaterThan(userIdx);
  });

  it('exec-guards every bundle branch with [ -f ] && [ -x ]', () => {
    const guarded = CHAIN_V1.match(/\[\s*-f\s+[^\]]+\]\s*&&\s*\[\s*-x\s+[^\]]+\]\s*&&\s*exec/g);
    expect(guarded?.length).toBe(3);
    expect(CHAIN_V1).toContain('command -v npx >/dev/null 2>&1 && exec npx');
  });

  it('covers nvm/fnm/asdf/brew/installer/local/volta probe locations', () => {
    for (const probe of [
      '$HOME/.nvm/versions/node',
      '$HOME/.fnm/node-versions',
      '$HOME/.asdf/installs/nodejs',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '$HOME/.local/bin',
      '$HOME/.volta/bin',
    ]) {
      expect(CHAIN_V1).toContain(probe);
    }
  });

  it('emits the documented stderr message and exit 127 on miss', () => {
    expect(CHAIN_V1).toContain(
      '"Open Knowledge: install OK Desktop or Node.js 24+, then restart your editor"',
    );
    expect(CHAIN_V1).toContain('>&2');
    expect(CHAIN_V1.trimEnd().endsWith('exit 127')).toBe(true);
  });
});

describe('buildManagedServerEntry', () => {
  const originalArgv1 = process.argv[1];
  beforeEach(() => {
    process.argv[1] = '/repo/packages/cli/src/cli.ts';
  });
  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  it('produces the resilient chain shape by default', () => {
    expect(buildManagedServerEntry()).toEqual({
      command: '/bin/sh',
      args: ['-l', '-c', CHAIN_V1],
    });
  });

  it('produces the chain shape when mode is explicitly published', () => {
    expect(buildManagedServerEntry({ mode: 'published' })).toEqual({
      command: '/bin/sh',
      args: ['-l', '-c', CHAIN_V1],
    });
  });

  it('produces the dev shape when mode is dev', () => {
    const entry = buildManagedServerEntry({ mode: 'dev' });
    expect(entry).toEqual({
      command: 'node',
      args: ['/repo/packages/cli/dist/cli.mjs', 'mcp'],
      env: { MCP_DEBUG: '1', OK_LOG_FILE: '/tmp/ok-mcp.log' },
    });
  });

  it('every consecutive call returns a freshly-constructed args array', () => {
    const a = buildManagedServerEntry();
    (a.args as unknown[]).push('extra');
    const b = buildManagedServerEntry();
    expect((b.args as unknown[]).length).toBe(3);
  });

  it('every chain-shaped editor target produces the byte-identical chain entry', () => {
    const editors: EditorId[] = ['claude', 'claude-desktop', 'cursor', 'codex'];
    const baseline = buildManagedServerEntry({ mode: 'published' });
    for (const id of editors) {
      const target = resolveEditorTargets([id])[0];
      const built = target.buildEntry('', { mode: 'published' });
      expect(built).toEqual(baseline);
    }
  });
});

describe('buildCopilotServerEntry', () => {
  const originalArgv1 = process.argv[1];
  beforeEach(() => {
    process.argv[1] = '/repo/packages/cli/src/cli.ts';
  });
  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  it('wraps the published chain in a Copilot local-server envelope', () => {
    expect(buildCopilotServerEntry({ mode: 'published' })).toEqual({
      type: 'local',
      command: '/bin/sh',
      args: ['-l', '-c', CHAIN_V1],
      tools: ['*'],
    });
  });

  it('wraps the dev chain (preserving env) in a Copilot local-server envelope', () => {
    expect(buildCopilotServerEntry({ mode: 'dev' })).toEqual({
      type: 'local',
      command: 'node',
      args: ['/repo/packages/cli/dist/cli.mjs', 'mcp'],
      env: { MCP_DEBUG: '1', OK_LOG_FILE: '/tmp/ok-mcp.log' },
      tools: ['*'],
    });
  });

  it('is the entry the copilot EDITOR_TARGET emits', () => {
    const target = resolveEditorTargets(['copilot'])[0];
    expect(target.buildEntry('', { mode: 'published' })).toEqual(
      buildCopilotServerEntry({ mode: 'published' }),
    );
  });

  it('installs a project skill at .github/skills but has no repo-local MCP config', () => {
    const target = resolveEditorTargets(['copilot'])[0];
    // Copilot CLI reads project skills from .github/skills (like claude-code reads
    // .claude/skills), but it has no repo-local MCP config — only the global
    // ~/.copilot/mcp-config.json — so projectConfigPath is intentionally undefined.
    expect(target.projectConfigPath).toBeUndefined();
    expect(target.projectSkillPath?.('/x')).toBe(
      join('/x', '.github', 'skills', 'open-knowledge', 'SKILL.md'),
    );
  });

  it('keeps the chain command/args so isEntryUpToDate still recognizes it', () => {
    expect(isEntryUpToDate(buildCopilotServerEntry({ mode: 'published' }))).toBe(true);
  });
});

describe('isEntryUpToDate', () => {
  it('true for the current chain shape', () => {
    expect(isEntryUpToDate(buildManagedServerEntry({ mode: 'published' }))).toBe(true);
  });

  it('true when only the body contains the sentinel (chain-text drift tolerated)', () => {
    const drifted = {
      command: '/bin/sh',
      args: ['-l', '-c', `${CHAIN_VERSION_SENTINEL}\n# trailing whitespace tolerated\nexit 127`],
    };
    expect(isEntryUpToDate(drifted)).toBe(true);
  });

  it('false for the legacy bare-npx shape', () => {
    expect(
      isEntryUpToDate({
        command: 'npx',
        args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'],
      }),
    ).toBe(false);
  });

  it('false for the bundle-direct shape', () => {
    expect(
      isEntryUpToDate({
        command: '/Applications/Open Knowledge.app/Contents/Resources/cli/bin/ok.sh',
        args: ['mcp'],
      }),
    ).toBe(false);
  });

  it('false for the legacy symlink shape', () => {
    expect(isEntryUpToDate({ command: '/usr/local/bin/ok', args: ['mcp'] })).toBe(false);
  });

  it('false for malformed entries', () => {
    for (const bad of [
      null,
      undefined,
      {},
      { command: '/bin/sh' },
      { command: '/bin/sh', args: ['-l', '-c'] },
      { command: '/bin/sh', args: ['-c', '-l', CHAIN_V1] }, // wrong arg order
      { command: '/bin/zsh', args: ['-l', '-c', CHAIN_V1] }, // wrong shell
      { command: '/bin/sh', args: ['-l', '-c', 'echo hi'] }, // wrong body
      'oops',
      42,
    ]) {
      expect(isEntryUpToDate(bad)).toBe(false);
    }
  });
});

describe('JSON encoding round-trip', () => {
  it('chain entry survives JSON.stringify/parse losslessly', () => {
    const entry = buildManagedServerEntry({ mode: 'published' });
    const roundTripped = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
    expect(roundTripped).toEqual(entry);
    expect((roundTripped.args as string[])[2]).toBe(CHAIN_V1);
  });
});

describe('resolveEditorTargets', () => {
  it('rejects prototype-chain editor IDs (toString, __proto__, hasOwnProperty)', () => {
    for (const evil of ['toString', '__proto__', 'hasOwnProperty', 'constructor']) {
      expect(() => resolveEditorTargets([evil as EditorId])).toThrow(/Unknown editor/);
    }
  });

  it('returns the matching targets for valid IDs', () => {
    const targets = resolveEditorTargets(['claude', 'cursor']);
    expect(targets).toHaveLength(2);
    expect(targets[0].id).toBe('claude');
    expect(targets[1].id).toBe('cursor');
  });
});
