import { describe, expect, test } from 'vitest';
import {
  classifyMcpLauncherEntry,
  type McpLauncherFamily,
  type McpLauncherRevisionCatalog,
} from './mcp-launcher.ts';

const UNIX_V1_HISTORICAL_CHAIN = `# ok-mcp-v1
USER_BUNDLE="$HOME/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$USER_BUNDLE" ] && [ -x "$USER_BUNDLE" ] && exec "$USER_BUNDLE" mcp
BUNDLE="/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$BUNDLE" ] && [ -x "$BUNDLE" ] && exec "$BUNDLE" mcp
command -v npx >/dev/null 2>&1 && exec npx -y @inkeep/open-knowledge@latest mcp
for d in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.asdf/installs/nodejs"/*/bin /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
  [ -f "$d/npx" ] && [ -x "$d/npx" ] && exec "$d/npx" -y @inkeep/open-knowledge@latest mcp
done
echo "OpenKnowledge: install OK Desktop or Node.js 24+, then restart your editor" >&2
exit 127`;

const WINDOWS_V1_HISTORICAL_CHAIN = `# ok-mcp-win-v1
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

const TEST_CATALOG_WITH_WINDOWS_V2 = {
  'unix-chain': {
    1: ['macos-bundle', 'npx-fallback'],
    2: ['macos-bundle', 'linux-deb-bundle', 'npx-fallback'],
  },
  'windows-chain': {
    1: ['windows-global-cli', 'npx-fallback'],
    2: ['windows-global-cli', 'npx-fallback'],
  },
} as const satisfies McpLauncherRevisionCatalog;

function marker(family: McpLauncherFamily, revision: number): string {
  return family === 'unix-chain' ? `# ok-mcp-v${revision}` : `# ok-mcp-win-v${revision}`;
}

const SHAPES = [
  {
    name: 'split Unix',
    family: 'unix-chain',
    wrap: (body: string): unknown => ({ command: '/bin/sh', args: ['-l', '-c', body] }),
  },
  {
    name: 'split Windows',
    family: 'windows-chain',
    wrap: (body: string): unknown => ({
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', body],
    }),
  },
  {
    name: 'OpenCode Unix',
    family: 'unix-chain',
    wrap: (body: string): unknown => ({
      type: 'local',
      enabled: true,
      command: ['/bin/sh', '-l', '-c', body],
    }),
  },
  {
    name: 'OpenCode Windows',
    family: 'windows-chain',
    wrap: (body: string): unknown => ({
      type: 'local',
      enabled: true,
      command: ['powershell', '-NoProfile', '-NonInteractive', '-Command', body],
    }),
  },
] as const;

describe('classifyMcpLauncherEntry', () => {
  test('keeps the current Unix launcher and describes its recognized contract', () => {
    expect(
      classifyMcpLauncherEntry({
        command: '/bin/sh',
        args: ['-l', '-c', '# ok-mcp-v2\nexec npx -y @inkeep/open-knowledge@latest mcp'],
      }),
    ).toEqual({
      kind: 'recognized',
      disposition: 'keep',
      descriptor: {
        envelope: 'split-command-args',
        family: 'unix-chain',
        revision: 2,
        knowledge: 'known',
        capabilities: ['macos-bundle', 'linux-deb-bundle', 'npx-fallback'],
      },
    });
  });

  test.each(SHAPES)('$name keeps its family-local current revision', ({ family, wrap }) => {
    const currentRevision = family === 'unix-chain' ? 2 : 1;
    const result = classifyMcpLauncherEntry(wrap(`${marker(family, currentRevision)}\nexit 127`));
    expect(result).toMatchObject({
      kind: 'recognized',
      disposition: 'keep',
      descriptor: { family, revision: currentRevision, knowledge: 'known' },
    });
  });

  test.each(SHAPES)('$name preserves a strictly recognized future revision', ({ family, wrap }) => {
    const futureRevision = family === 'unix-chain' ? 3 : 2;
    expect(
      classifyMcpLauncherEntry(wrap(`${marker(family, futureRevision)}\nexit 127`)),
    ).toMatchObject({
      kind: 'recognized',
      disposition: 'keep',
      descriptor: {
        family,
        revision: futureRevision,
        knowledge: 'future',
        capabilities: 'opaque',
      },
    });
  });

  test.each(SHAPES)('$name requires its marker on the first line', ({ family, wrap }) => {
    expect(
      classifyMcpLauncherEntry(wrap(`echo preparing\n${marker(family, 99)}\nexit 127`)),
    ).toEqual({ kind: 'declined', reason: 'malformed-marker' });
  });

  test('upgrades known older revisions within each family', () => {
    expect(
      classifyMcpLauncherEntry({
        command: '/bin/sh',
        args: ['-l', '-c', UNIX_V1_HISTORICAL_CHAIN],
      }),
    ).toMatchObject({
      kind: 'recognized',
      disposition: 'upgrade',
      descriptor: { family: 'unix-chain', revision: 1, knowledge: 'known' },
    });

    expect(
      classifyMcpLauncherEntry(
        {
          command: 'powershell',
          args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_V1_HISTORICAL_CHAIN],
        },
        TEST_CATALOG_WITH_WINDOWS_V2,
      ),
    ).toMatchObject({
      kind: 'recognized',
      disposition: 'upgrade',
      descriptor: { family: 'windows-chain', revision: 1, knowledge: 'known' },
    });
  });

  test('orders revisions only within a family', () => {
    const unixV1Build = {
      'unix-chain': { 1: ['macos-bundle', 'npx-fallback'] },
      'windows-chain': { 1: ['windows-global-cli', 'npx-fallback'] },
    } as const satisfies McpLauncherRevisionCatalog;

    expect(
      classifyMcpLauncherEntry(
        { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v2\nexit 127'] },
        unixV1Build,
      ),
    ).toMatchObject({
      kind: 'recognized',
      disposition: 'keep',
      descriptor: { family: 'unix-chain', revision: 2, knowledge: 'future' },
    });
    expect(
      classifyMcpLauncherEntry({
        command: '/bin/sh',
        args: ['-l', '-c', UNIX_V1_HISTORICAL_CHAIN],
      }),
    ).toMatchObject({ kind: 'recognized', disposition: 'upgrade' });
    expect(
      classifyMcpLauncherEntry({
        command: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_V1_HISTORICAL_CHAIN],
      }),
    ).toMatchObject({
      kind: 'recognized',
      disposition: 'keep',
      descriptor: { family: 'windows-chain', revision: 1 },
    });
  });

  test.each([
    [null, 'not-an-object'],
    [{ command: '/bin/zsh', args: ['-l', '-c', '# ok-mcp-v2'] }, 'foreign-command'],
    [{ command: '/bin/sh', args: ['-c', '# ok-mcp-v2'] }, 'malformed-argv'],
    [{ command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v2', 'extra'] }, 'malformed-argv'],
    [{ type: 'remote', command: ['/bin/sh', '-l', '-c', '# ok-mcp-v2'] }, 'unknown-envelope'],
    [{ command: 'node', args: ['/tmp/cli.mjs', 'mcp'] }, 'dev-mode'],
    [{ type: 'local', command: ['node', '/tmp/cli.mjs', 'mcp'] }, 'dev-mode'],
    [{ type: 'local', command: ['/bin/sh', '-l', '-c', '# ok-mcp-v2', 'extra'] }, 'malformed-argv'],
  ] as const)('declines %j with bounded reason %s', (entry, reason) => {
    expect(classifyMcpLauncherEntry(entry)).toEqual({ kind: 'declined', reason });
  });
});
