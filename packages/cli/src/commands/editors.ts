import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import {
  ALL_EDITOR_IDS as CORE_ALL_EDITOR_IDS,
  EDITOR_LABELS as CORE_EDITOR_LABELS,
  HOSTS_WITH_USER_SKILL_DIR as CORE_HOSTS_WITH_USER_SKILL_DIR,
  type EditorId as CoreEditorId,
} from '@inkeep/open-knowledge-core';
import { MCP_SERVER_NAME } from '@inkeep/open-knowledge-server';

export type EditorId = CoreEditorId;
export const ALL_EDITOR_IDS: readonly EditorId[] = CORE_ALL_EDITOR_IDS;
export const EDITOR_LABELS: Record<EditorId, string> = CORE_EDITOR_LABELS;
export const HOSTS_WITH_USER_SKILL_DIR = CORE_HOSTS_WITH_USER_SKILL_DIR;

const DEV_MCP_SERVER_COMMAND = 'node';
const DEV_MCP_ENV = {
  MCP_DEBUG: '1',
  OK_LOG_FILE: '/tmp/ok-mcp.log',
} as const;

export const CHAIN_VERSION_SENTINEL = '# ok-mcp-v2';

export const CHAIN_V2 = `# ok-mcp-v2
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

export const CHAIN_WIN_VERSION_SENTINEL = '# ok-mcp-win-v1';

const OK_MCP_CHAIN_MARKER = '# ok-mcp';

export const CHAIN_WIN_V1 = `# ok-mcp-win-v1
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

export const PI_EXTENSION_OWNERSHIP_MARKER = '// ok-pi-bridge';

export const PI_EXTENSION_VERSION_SENTINEL = `${PI_EXTENSION_OWNERSHIP_MARKER}-v1`;

export const PI_MANAGED_FILE_ENTRY_COMMAND = 'ok-pi-managed-extension';

type McpInstallMode = 'published' | 'dev';

export interface McpInstallOptions {
  mode?: McpInstallMode;
  platformName?: NodeJS.Platform;
  skipAvailabilityCheck?: boolean;
  home?: string;
}

export function isEntryUpToDate(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;

  if (e.command === '/bin/sh') {
    if (!Array.isArray(e.args)) return false;
    if (e.args[0] !== '-l' || e.args[1] !== '-c') return false;
    const body = e.args[2];
    return typeof body === 'string' && body.includes(CHAIN_VERSION_SENTINEL);
  }

  if (e.command === 'powershell') {
    if (!Array.isArray(e.args)) return false;
    if (e.args[0] !== '-NoProfile' || e.args[1] !== '-NonInteractive' || e.args[2] !== '-Command') {
      return false;
    }
    const body = e.args[3];
    return typeof body === 'string' && body.includes(CHAIN_WIN_VERSION_SENTINEL);
  }

  if (e.type === 'local' && Array.isArray(e.command)) {
    if (e.command[0] === '/bin/sh') {
      if (e.command[1] !== '-l' || e.command[2] !== '-c') return false;
      const body = e.command[3];
      return typeof body === 'string' && body.includes(CHAIN_VERSION_SENTINEL);
    }
    if (e.command[0] === 'powershell') {
      if (
        e.command[1] !== '-NoProfile' ||
        e.command[2] !== '-NonInteractive' ||
        e.command[3] !== '-Command'
      ) {
        return false;
      }
      const body = e.command[4];
      return typeof body === 'string' && body.includes(CHAIN_WIN_VERSION_SENTINEL);
    }
    return false;
  }

  if (e.command === PI_MANAGED_FILE_ENTRY_COMMAND) {
    if (!Array.isArray(e.args)) return false;
    const text = e.args[0];
    return typeof text === 'string' && text.startsWith(PI_EXTENSION_VERSION_SENTINEL);
  }

  return false;
}

function resolveDevCliDistPath(entryPath: string = process.argv[1]): string {
  if (!entryPath) {
    throw new Error(
      'Cannot infer the local CLI entry for --dev-mcp because process.argv[1] is empty.',
    );
  }

  const resolvedEntry = resolve(entryPath);
  if (basename(resolvedEntry) === 'cli.mjs' && basename(dirname(resolvedEntry)) === 'dist') {
    return resolvedEntry;
  }

  const pathParts = resolvedEntry.split(sep);
  const packagesIndex = pathParts.lastIndexOf('packages');
  if (packagesIndex === -1 || pathParts[packagesIndex + 1] !== 'cli') {
    throw new Error(
      `Cannot infer the repo root for --dev-mcp from ${resolvedEntry}. Run the local CLI from this repo so the built dist path can be derived.`,
    );
  }

  const rootParts = pathParts.slice(0, packagesIndex);
  const repoRoot = rootParts.length === 0 ? sep : rootParts.join(sep);
  return join(repoRoot, 'packages', 'cli', 'dist', 'cli.mjs');
}

export function buildManagedServerEntry(options: McpInstallOptions = {}): Record<string, unknown> {
  if (options.mode === 'dev') {
    return {
      command: DEV_MCP_SERVER_COMMAND,
      args: [resolveDevCliDistPath(), 'mcp'],
      env: { ...DEV_MCP_ENV },
    };
  }

  const platformName = options.platformName ?? process.platform;
  if (platformName === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', CHAIN_WIN_V1],
    };
  }
  return {
    command: '/bin/sh',
    args: ['-l', '-c', CHAIN_V2],
  };
}

function buildOpenCodeEntry(options: McpInstallOptions = {}): Record<string, unknown> {
  if (options.mode === 'dev') {
    return {
      type: 'local',
      enabled: true,
      command: [DEV_MCP_SERVER_COMMAND, resolveDevCliDistPath(), 'mcp'],
      environment: { ...DEV_MCP_ENV },
    };
  }

  const platformName = options.platformName ?? process.platform;
  if (platformName === 'win32') {
    return {
      type: 'local',
      enabled: true,
      command: ['powershell', '-NoProfile', '-NonInteractive', '-Command', CHAIN_WIN_V1],
    };
  }
  return {
    type: 'local',
    enabled: true,
    command: ['/bin/sh', '-l', '-c', CHAIN_V2],
  };
}

export function isOwnManagedEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    matchesCanonicalExactly(
      e,
      buildManagedServerEntry({ mode: 'published', platformName: 'darwin' }),
    ) ||
    matchesCanonicalExactly(
      e,
      buildManagedServerEntry({ mode: 'published', platformName: 'win32' }),
    )
  );
}

function matchesCanonicalExactly(
  e: Record<string, unknown>,
  canonical: Record<string, unknown>,
): boolean {
  if (Object.keys(e).length !== Object.keys(canonical).length) return false;
  return commandArgsMatchCanonical(e, canonical);
}

function commandArgsMatchCanonical(
  e: Record<string, unknown>,
  canonical: Record<string, unknown>,
): boolean {
  if (e.command !== canonical.command) return false;
  const canonicalArgs = canonical.args;
  if (!Array.isArray(canonicalArgs) || !Array.isArray(e.args)) return false;
  if (e.args.length !== canonicalArgs.length) return false;
  return e.args.every((v, i) => v === canonicalArgs[i]);
}

function chainArgvRunsOwnManagedServer(argv: unknown[], interpreter: string): boolean {
  const bodyIsOk = (body: unknown): boolean =>
    typeof body === 'string' && body.includes(OK_MCP_CHAIN_MARKER);
  if (interpreter === '/bin/sh') {
    return argv[0] === '-l' && argv[1] === '-c' && bodyIsOk(argv[2]);
  }
  if (interpreter === 'powershell') {
    return (
      argv[0] === '-NoProfile' &&
      argv[1] === '-NonInteractive' &&
      argv[2] === '-Command' &&
      bodyIsOk(argv[3])
    );
  }
  return false;
}

export function entryRunsOwnManagedServer(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e.enabled === false) return false;
  if (typeof e.command !== 'string' || !Array.isArray(e.args)) return false;
  return chainArgvRunsOwnManagedServer(e.args, e.command);
}

export function openCodeEntryRunsOwnManagedServer(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e.type !== 'local' || e.enabled === false) return false;
  if (!Array.isArray(e.command)) return false;
  const [interpreter, ...argv] = e.command;
  return typeof interpreter === 'string' && chainArgvRunsOwnManagedServer(argv, interpreter);
}

export interface AppSupportOptions {
  home?: string;
  platformName?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function pathApiForPlatform(platformName: NodeJS.Platform) {
  return platformName === 'win32' ? win32 : posix;
}

export function resolveAppSupportPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const pathApi = pathApiForPlatform(platformName);

  if (platformName === 'darwin') {
    return pathApi.join(home, 'Library', 'Application Support');
  }

  if (platformName === 'win32') {
    return env.APPDATA || pathApi.join(home, 'AppData', 'Roaming');
  }

  return env.XDG_CONFIG_HOME || pathApi.join(home, '.config');
}

export function resolveClaudeCodeConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  return pathApiForPlatform(platformName).join(home, '.claude.json');
}

export function resolveClaudeDesktopConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  if (platformName === 'darwin') {
    return posix.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }

  if (platformName === 'win32') {
    const appData = env.APPDATA ?? win32.join(home, 'AppData', 'Roaming');
    return win32.join(appData, 'Claude', 'claude_desktop_config.json');
  }

  throw new Error(`Claude Desktop is not available on ${platformName}. Supported: macOS, Windows.`);
}

export function resolveCursorConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  return pathApiForPlatform(platformName).join(home, '.cursor', 'mcp.json');
}

function resolveCodexHomePath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  return env.CODEX_HOME ?? pathApiForPlatform(platformName).join(home, '.codex');
}

export function resolveCodexConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  return pathApiForPlatform(platformName).join(resolveCodexHomePath(options), 'config.toml');
}

export function resolveCopilotConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const copilotHome = env.COPILOT_HOME ?? pathApiForPlatform(platformName).join(home, '.copilot');
  return pathApiForPlatform(platformName).join(copilotHome, 'mcp-config.json');
}

function resolveOpenCodeConfigDir(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const pathApi = pathApiForPlatform(platformName);
  if (platformName === 'win32') {
    const appData = env.APPDATA ?? pathApi.join(home, 'AppData', 'Roaming');
    return pathApi.join(appData, 'opencode');
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME ?? pathApi.join(home, '.config');
  return pathApi.join(xdgConfigHome, 'opencode');
}

export function resolveOpenCodeConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  return pathApiForPlatform(platformName).join(resolveOpenCodeConfigDir(options), 'opencode.json');
}

export function resolveOpenClawConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  return pathApiForPlatform(platformName).join(home, '.openclaw', 'openclaw.json');
}

export function resolveHermesConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  return pathApiForPlatform(platformName).join(home, '.hermes', 'config.yaml');
}

export function resolvePiAgentDirPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  return env.PI_CODING_AGENT_DIR ?? pathApiForPlatform(platformName).join(home, '.pi', 'agent');
}

export function resolveAntigravityConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  return pathApiForPlatform(platformName).join(home, '.gemini', 'config', 'mcp_config.json');
}

interface LmStudioCandidate {
  readonly file: string;
  readonly dir: string;
}

function lmStudioConfigCandidates(
  home: string,
  platformName: NodeJS.Platform,
): [LmStudioCandidate, LmStudioCandidate] {
  const pathApi = pathApiForPlatform(platformName);
  return [
    { file: pathApi.join(home, '.lmstudio', 'mcp.json'), dir: pathApi.join(home, '.lmstudio') },
    {
      file: pathApi.join(home, '.cache', 'lm-studio', 'mcp.json'),
      dir: pathApi.join(home, '.cache', 'lm-studio'),
    },
  ];
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function resolveLmStudioConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  const [documented, cache] = lmStudioConfigCandidates(home, platformName);
  const existingFile = [documented, cache].find((c) => existsSync(c.file));
  if (existingFile) return existingFile.file;
  if (isNonEmptyDir(cache.dir)) return cache.file;
  return documented.file;
}

export interface EditorMcpTarget {
  id: EditorId;
  label: string;
  configPath: (cwd: string, home?: string) => string;
  format: 'json' | 'toml' | 'yaml' | 'file';
  topLevelKey: 'mcpServers' | 'servers' | 'mcp_servers' | 'mcp';
  serverMapSubKey?: string;
  offerOnlyWhenDetected?: boolean;
  serverName: (cwd: string) => string;
  buildEntry: (cwd: string, options?: McpInstallOptions) => Record<string, unknown>;
  scope: 'project' | 'global';
  detectPath?: (cwd: string, home?: string) => string;
  projectConfigPath?: (cwd: string) => string;
  projectSkillPath?: (cwd: string) => string;
}

export function editorEntryLocator(target: EditorMcpTarget): string {
  const server = target.serverName('');
  return target.format === 'toml'
    ? `[${target.topLevelKey}.${server}]`
    : [target.topLevelKey, target.serverMapSubKey, server].filter(Boolean).join('.');
}

export function editorConfigPathDisplay(target: EditorMcpTarget, home: string): string | null {
  let abs: string;
  try {
    abs = target.configPath('', home);
  } catch {
    return null;
  }
  return abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}

export const EDITOR_TARGETS: Record<EditorId, EditorMcpTarget> = {
  claude: {
    id: 'claude',
    label: EDITOR_LABELS.claude,
    configPath: (_cwd, home) => resolveClaudeCodeConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => join(home ?? homedir(), '.claude'),
    projectConfigPath: (cwd) => join(cwd, '.mcp.json'),
    projectSkillPath: (cwd) => join(cwd, '.claude', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  'claude-desktop': {
    id: 'claude-desktop',
    label: EDITOR_LABELS['claude-desktop'],
    configPath: (_cwd, home) => resolveClaudeDesktopConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => dirname(resolveClaudeDesktopConfigPath({ home })),
  },
  cursor: {
    id: 'cursor',
    label: EDITOR_LABELS.cursor,
    configPath: (_cwd, home) => resolveCursorConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => dirname(resolveCursorConfigPath({ home })),
    projectConfigPath: (cwd) => join(cwd, '.cursor', 'mcp.json'),
    projectSkillPath: (cwd) => join(cwd, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  codex: {
    id: 'codex',
    label: EDITOR_LABELS.codex,
    configPath: (_cwd, home) => resolveCodexConfigPath({ home }),
    format: 'toml',
    topLevelKey: 'mcp_servers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => dirname(resolveCodexConfigPath({ home })),
    projectConfigPath: (cwd) => join(cwd, '.codex', 'config.toml'),
    projectSkillPath: (cwd) => join(cwd, '.codex', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  copilot: {
    id: 'copilot',
    label: EDITOR_LABELS.copilot,
    configPath: (_cwd, home) => resolveCopilotConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => dirname(resolveCopilotConfigPath({ home })),
    projectSkillPath: (cwd) => join(cwd, '.github', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  opencode: {
    id: 'opencode',
    label: EDITOR_LABELS.opencode,
    configPath: (_cwd, home) => resolveOpenCodeConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcp',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildOpenCodeEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => dirname(resolveOpenCodeConfigPath({ home })),
    projectConfigPath: (cwd) => join(cwd, 'opencode.json'),
    projectSkillPath: (cwd) => join(cwd, '.opencode', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  openclaw: {
    id: 'openclaw',
    label: EDITOR_LABELS.openclaw,
    configPath: (_cwd, home) => resolveOpenClawConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcp',
    serverMapSubKey: 'servers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => join(home ?? homedir(), '.openclaw'),
    offerOnlyWhenDetected: true,
  },
  pi: {
    id: 'pi',
    label: EDITOR_LABELS.pi,
    configPath: () => {
      throw new Error(
        "Pi has no user-global MCP config; OK's integration is the project-scoped bridge extension at .pi/extensions/open-knowledge.ts (run `ok init` in the project).",
      );
    },
    format: 'file',
    topLevelKey: 'mcpServers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: () => {
      throw new Error(
        'Pi has no MCP entry shape; the managed bridge file is built by buildPiExtensionSource (integrations/pi-extension.ts).',
      );
    },
    scope: 'project',
    detectPath: (_cwd, home) => resolvePiAgentDirPath({ home }),
    projectConfigPath: (cwd) => join(cwd, '.pi', 'extensions', 'open-knowledge.ts'),
    projectSkillPath: (cwd) => join(cwd, '.pi', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  antigravity: {
    id: 'antigravity',
    label: EDITOR_LABELS.antigravity,
    configPath: (_cwd, home) => resolveAntigravityConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => join(home ?? homedir(), '.gemini'),
    offerOnlyWhenDetected: true,
  },
  'lm-studio': {
    id: 'lm-studio',
    label: EDITOR_LABELS['lm-studio'],
    configPath: (_cwd, home) => resolveLmStudioConfigPath({ home }),
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => dirname(resolveLmStudioConfigPath({ home })),
    offerOnlyWhenDetected: true,
  },
  hermes: {
    id: 'hermes',
    label: EDITOR_LABELS.hermes,
    configPath: (_cwd, home) => resolveHermesConfigPath({ home }),
    format: 'yaml',
    topLevelKey: 'mcp_servers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => join(home ?? homedir(), '.hermes'),
    offerOnlyWhenDetected: true,
  },
};

export function resolveEditorTargets(ids: EditorId[]): EditorMcpTarget[] {
  const unknown = ids.filter((id) => !Object.hasOwn(EDITOR_TARGETS, id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown editor(s): ${unknown.join(', ')}. Valid options: ${ALL_EDITOR_IDS.join(', ')}`,
    );
  }
  return ids.map((id) => EDITOR_TARGETS[id]);
}
