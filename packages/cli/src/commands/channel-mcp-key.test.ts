import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPiExtensionSource,
  isOwnPiExtensionSource,
  isPiExtensionSourceUpToDate,
} from '../integrations/pi-extension.ts';
import {
  buildManagedServerEntry,
  CHAIN_V2,
  CHAIN_WIN_V1,
  EDITOR_TARGETS,
  isEntryUpToDate,
  isOwnManagedEntry,
} from './editors.ts';
import { writeEditorMcpConfig } from './init.ts';

const STABLE_UNIX_CHAIN = `# ok-mcp-v2
USER_BUNDLE="$HOME/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$USER_BUNDLE" ] && [ -x "$USER_BUNDLE" ] && exec "$USER_BUNDLE" mcp
BUNDLE="/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$BUNDLE" ] && [ -x "$BUNDLE" ] && exec "$BUNDLE" mcp
DEB_BUNDLE="/opt/OpenKnowledge/resources/cli/bin/ok.sh"
[ -f "$DEB_BUNDLE" ] && [ -x "$DEB_BUNDLE" ] && exec "$DEB_BUNDLE" mcp
command -v npx >/dev/null 2>&1 && exec npx -y @inkeep/open-knowledge@latest mcp
for d in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.asdf/installs/nodejs"/*/bin /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
  [ -f "$d/npx" ] && [ -x "$d/npx" ] && exec "$d/npx" -y @inkeep/open-knowledge@latest mcp
done
echo "OpenKnowledge: install OK Desktop or Node.js 24+, then restart your editor" >&2
exit 127`;

const STABLE_WIN_CHAIN = `# ok-mcp-win-v1
if ($env:PATHEXT -notmatch 'CMD') { $env:PATHEXT = '.COM;.EXE;.BAT;.CMD;' + $env:PATHEXT }
if ($env:APPDATA) {
  $shim = Join-Path $env:APPDATA 'npm\\ok.cmd'
  if (Test-Path -LiteralPath $shim -PathType Leaf) { & $shim mcp; exit $LASTEXITCODE }
}
$ok = Get-Command ok.cmd -CommandType Application -ErrorAction SilentlyContinue
if ($ok) { & $ok.Source mcp; exit $LASTEXITCODE }
$npx = Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue
if ($npx) { & $npx.Source -y '@inkeep/open-knowledge@latest' mcp; exit $LASTEXITCODE }
$dirs = @()
if ($env:ProgramFiles) { $dirs += Join-Path $env:ProgramFiles 'nodejs' }
if ($env:NVM_SYMLINK) { $dirs += $env:NVM_SYMLINK }
if ($env:LOCALAPPDATA) {
  $dirs += Join-Path $env:LOCALAPPDATA 'fnm\\aliases\\default'
  $dirs += Join-Path $env:LOCALAPPDATA 'Volta\\bin'
  $dirs += Join-Path $env:LOCALAPPDATA 'pnpm'
}
if ($env:USERPROFILE) { $dirs += Join-Path $env:USERPROFILE 'scoop\\shims' }
foreach ($d in $dirs) {
  $probe = Join-Path $d 'npx.cmd'
  if (Test-Path -LiteralPath $probe -PathType Leaf) { & $probe -y '@inkeep/open-knowledge@latest' mcp; exit $LASTEXITCODE }
}
[Console]::Error.WriteLine('OpenKnowledge: install Node.js 24+ (npm i -g @inkeep/open-knowledge), then restart your editor')
exit 127`;

const BETA_UNIX_CHAIN = `# ok-mcp-beta-v2
export OK_CHANNEL=beta
USER_BUNDLE="$HOME/Applications/OpenKnowledge Beta.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$USER_BUNDLE" ] && [ -x "$USER_BUNDLE" ] && exec "$USER_BUNDLE" mcp
BUNDLE="/Applications/OpenKnowledge Beta.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$BUNDLE" ] && [ -x "$BUNDLE" ] && exec "$BUNDLE" mcp
DEB_BUNDLE="/opt/OpenKnowledge Beta/resources/cli/bin/ok.sh"
[ -f "$DEB_BUNDLE" ] && [ -x "$DEB_BUNDLE" ] && exec "$DEB_BUNDLE" mcp
command -v npx >/dev/null 2>&1 && exec npx -y @inkeep/open-knowledge@beta mcp
for d in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.asdf/installs/nodejs"/*/bin /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
  [ -f "$d/npx" ] && [ -x "$d/npx" ] && exec "$d/npx" -y @inkeep/open-knowledge@beta mcp
done
echo "OpenKnowledge: install OK Desktop or Node.js 24+, then restart your editor" >&2
exit 127`;

const BETA_WIN_CHAIN = `# ok-mcp-beta-win-v1
$env:OK_CHANNEL = 'beta'
if ($env:PATHEXT -notmatch 'CMD') { $env:PATHEXT = '.COM;.EXE;.BAT;.CMD;' + $env:PATHEXT }
if ($env:APPDATA) {
  $shim = Join-Path $env:APPDATA 'npm\\ok-beta.cmd'
  if (Test-Path -LiteralPath $shim -PathType Leaf) { & $shim mcp; exit $LASTEXITCODE }
}
$ok = Get-Command ok-beta.cmd -CommandType Application -ErrorAction SilentlyContinue
if ($ok) { & $ok.Source mcp; exit $LASTEXITCODE }
$npx = Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue
if ($npx) { & $npx.Source -y '@inkeep/open-knowledge@beta' mcp; exit $LASTEXITCODE }
$dirs = @()
if ($env:ProgramFiles) { $dirs += Join-Path $env:ProgramFiles 'nodejs' }
if ($env:NVM_SYMLINK) { $dirs += $env:NVM_SYMLINK }
if ($env:LOCALAPPDATA) {
  $dirs += Join-Path $env:LOCALAPPDATA 'fnm\\aliases\\default'
  $dirs += Join-Path $env:LOCALAPPDATA 'Volta\\bin'
  $dirs += Join-Path $env:LOCALAPPDATA 'pnpm'
}
if ($env:USERPROFILE) { $dirs += Join-Path $env:USERPROFILE 'scoop\\shims' }
foreach ($d in $dirs) {
  $probe = Join-Path $d 'npx.cmd'
  if (Test-Path -LiteralPath $probe -PathType Leaf) { & $probe -y '@inkeep/open-knowledge@beta' mcp; exit $LASTEXITCODE }
}
[Console]::Error.WriteLine('OpenKnowledge: install Node.js 24+ (npm i -g @inkeep/open-knowledge@beta), then restart your editor')
exit 127`;

describe('per-channel MCP registration', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-channel-key-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function writeClaude(): Record<string, unknown> {
    const result = writeEditorMcpConfig(
      EDITOR_TARGETS.claude,
      '',
      { mode: 'published', platformName: 'darwin', skipAvailabilityCheck: true },
      home,
    );
    expect(result.action).not.toBe('failed');
    return JSON.parse(readFileSync(EDITOR_TARGETS.claude.configPath('', home), 'utf-8')).mcpServers;
  }

  it('beta writes its own key and chain, leaving the stable entry byte-for-byte', () => {
    writeClaude();
    const stableEntry = JSON.stringify(
      JSON.parse(readFileSync(EDITOR_TARGETS.claude.configPath('', home), 'utf-8')).mcpServers[
        'open-knowledge'
      ],
    );

    vi.stubEnv('OK_CHANNEL', 'beta');
    const servers = writeClaude();

    expect(JSON.stringify(servers['open-knowledge'])).toBe(stableEntry);
    const beta = servers['open-knowledge-beta'] as { args: string[] };
    expect(beta.args[2]).toMatch(/^# ok-mcp-beta-v2\n/);
    expect(beta.args[2]).toContain('/Applications/OpenKnowledge Beta.app/');
    expect(beta.args[2]).toContain('@inkeep/open-knowledge@beta mcp');
  });

  it('stable repair leaves the beta entry alone', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    writeClaude();
    const path = EDITOR_TARGETS.claude.configPath('', home);
    const betaEntry = JSON.stringify(
      JSON.parse(readFileSync(path, 'utf-8')).mcpServers['open-knowledge-beta'],
    );

    vi.stubEnv('OK_CHANNEL', 'stable');
    const servers = writeClaude();

    expect(JSON.stringify(servers['open-knowledge-beta'])).toBe(betaEntry);
    expect((servers['open-knowledge'] as { args: string[] }).args[2]).toBe(STABLE_UNIX_CHAIN);
  });

  it('stable chains are pinned byte-for-byte to the shipped launcher', () => {
    expect(CHAIN_V2).toBe(STABLE_UNIX_CHAIN);
    expect(CHAIN_WIN_V1).toBe(STABLE_WIN_CHAIN);
    const unix = buildManagedServerEntry({ mode: 'published', platformName: 'darwin' });
    const win = buildManagedServerEntry({ mode: 'published', platformName: 'win32' });
    expect((unix.args as string[])[2]).toBe(STABLE_UNIX_CHAIN);
    expect((win.args as string[])[3]).toBe(STABLE_WIN_CHAIN);
  });

  it('beta chains are pinned byte-for-byte so no launch target falls back to stable', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    const unix = buildManagedServerEntry({ mode: 'published', platformName: 'linux' });
    const win = buildManagedServerEntry({ mode: 'published', platformName: 'win32' });
    expect((unix.args as string[])[2]).toBe(BETA_UNIX_CHAIN);
    expect((win.args as string[])[3]).toBe(BETA_WIN_CHAIN);
  });

  it('each channel only counts its own chain as current and owned', () => {
    const stableEntry = buildManagedServerEntry({ mode: 'published', platformName: 'darwin' });
    vi.stubEnv('OK_CHANNEL', 'beta');
    const betaEntry = buildManagedServerEntry({ mode: 'published', platformName: 'darwin' });
    const betaWin = buildManagedServerEntry({ mode: 'published', platformName: 'win32' });

    expect(isEntryUpToDate(betaEntry)).toBe(true);
    expect(isOwnManagedEntry(betaEntry)).toBe(true);
    expect(isEntryUpToDate(stableEntry)).toBe(false);
    expect(isOwnManagedEntry(stableEntry)).toBe(false);
    expect((betaWin.args as string[])[3]).toMatch(/^# ok-mcp-beta-win-v1\n/);
    expect((betaWin.args as string[])[3]).toContain('Get-Command ok-beta.cmd');
    expect((betaWin.args as string[])[3].split('\n')[1]).toBe("$env:OK_CHANNEL = 'beta'");
    expect((betaEntry.args as string[])[2].split('\n')[1]).toBe('export OK_CHANNEL=beta');

    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(isEntryUpToDate(betaEntry)).toBe(false);
    expect(isOwnManagedEntry(betaEntry)).toBe(false);
  });

  it('beta writes a new entry even when the config already holds stable', () => {
    const path = EDITOR_TARGETS.claude.configPath('', home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { 'open-knowledge': { command: 'custom' } } }),
      'utf-8',
    );
    vi.stubEnv('OK_CHANNEL', 'beta');
    const servers = writeClaude();
    expect(servers['open-knowledge']).toEqual({ command: 'custom' });
    expect(servers['open-knowledge-beta']).toBeDefined();
  });

  it('each channel owns its own Pi bridge file and never claims the other one', () => {
    const stableSource = buildPiExtensionSource({ mode: 'published' });
    const stablePath = EDITOR_TARGETS.pi.projectConfigPath('/p');
    vi.stubEnv('OK_CHANNEL', 'beta');
    const betaSource = buildPiExtensionSource({ mode: 'published' });
    const betaPath = EDITOR_TARGETS.pi.projectConfigPath('/p');

    expect(stablePath).toBe(join('/p', '.pi', 'extensions', 'open-knowledge.ts'));
    expect(betaPath).toBe(join('/p', '.pi', 'extensions', 'open-knowledge-beta.ts'));
    expect(betaSource.split('\n')[0]).toBe('// ok-pi-bridge-beta-v1');
    expect(betaSource).toContain('# ok-mcp-beta-v2');
    expect(betaSource).toContain('const TOOL_PREFIX = "ok-beta_"');
    expect(stableSource).toContain('const TOOL_PREFIX = "ok_"');
    expect(isOwnPiExtensionSource(betaSource)).toBe(true);
    expect(isPiExtensionSourceUpToDate(betaSource)).toBe(true);
    expect(isOwnPiExtensionSource(stableSource)).toBe(false);
    expect(isPiExtensionSourceUpToDate(stableSource)).toBe(false);

    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(stableSource.split('\n')[0]).toBe('// ok-pi-bridge-v1');
    expect(isOwnPiExtensionSource(stableSource)).toBe(true);
    expect(isOwnPiExtensionSource(betaSource)).toBe(false);
    expect(isPiExtensionSourceUpToDate(betaSource)).toBe(false);
  });
});
