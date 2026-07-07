/**
 * Editor MCP target registry.
 *
 * Each editor has a different location and config format for MCP server
 * configuration. This module encodes those differences declaratively so that
 * `init.ts` can loop over targets without per-editor branching.
 */
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import {
  ALL_EDITOR_IDS as CORE_ALL_EDITOR_IDS,
  EDITOR_LABELS as CORE_EDITOR_LABELS,
  HOSTS_WITH_USER_SKILL_DIR as CORE_HOSTS_WITH_USER_SKILL_DIR,
  type EditorId as CoreEditorId,
} from '@inkeep/open-knowledge-core';
import { MCP_SERVER_NAME } from '@inkeep/open-knowledge-server';

// Re-export the canonical surface so existing CLI consumers can import via the package name (`@inkeep/open-knowledge`)
export type EditorId = CoreEditorId;
export const ALL_EDITOR_IDS: readonly EditorId[] = CORE_ALL_EDITOR_IDS;
export const EDITOR_LABELS: Record<EditorId, string> = CORE_EDITOR_LABELS;
/** Re-export of core's derived list — the host-dir sweep set for `repair-skills`
 *  (CLI) + `skill-reclaim` (desktop). Both import it from the package surface. */
export const HOSTS_WITH_USER_SKILL_DIR = CORE_HOSTS_WITH_USER_SKILL_DIR;

const DEV_MCP_SERVER_COMMAND = 'node';
const DEV_MCP_ENV = {
  MCP_DEBUG: '1',
  OK_LOG_FILE: '/tmp/ok-mcp.log',
} as const;

/**
 * Resilient chain (v1) — the Unix member of the two-shape canonical set
 * (Windows sibling: `CHAIN_WIN_V1`). One byte-identical entry every
 * macOS/Linux developer's editor sees.
 *
 * At MCP-host spawn time, `/bin/sh -l -c CHAIN_V1` resolves whichever runtime
 * is locally available — bundle first, then `npx` on a login-shell PATH, then
 * an explicit glob across the common version-manager directories. DMG-only
 * users (no Node) hit the bundle branch; npm-installed CLI users hit `npx`;
 * teammates with neither see the structured stderr and exit 127.
 *
 * Two bundle probes — user-local first (`$HOME/Applications`), then the
 * system path (`/Applications`). Matches `findBundledOkPath` in
 * `packages/cli/src/mcp/bundle-proxy.ts`, which already treats the user-local
 * install as first-class for users on locked-down macs or non-admin macOS
 * accounts. Diverging here would silently drop the bundle branch for the
 * exact DMG persona it exists to serve.
 *
 * Each branch is empirically load-bearing:
 *   1. `[ -f ] && [ -x ]` BEFORE every `exec`. `exec MISSING_FILE` in a
 *      non-interactive `sh -c` aborts the shell with 126 before `||` can
 *      fire — `exec a || exec b` is broken. `[ -f ]` also filters
 *      directories (which `[ -x ]` alone treats as executable).
 *   2. `/bin/sh` not `$SHELL` and not `/bin/zsh`. zsh errors on unmatched
 *      globs (`zsh: no matches found`); POSIX sh leaves the literal and
 *      `[ -f ]` rejects it. Also keeps the config bytes identical across
 *      developer machines (no `$SHELL` substitution at write time).
 *   3. `-l` login flag. macOS `/bin/sh -l` sources `/etc/profile`, which
 *      runs `path_helper` — populates PATH with brew/installer Node
 *      locations without baking the user's shell.
 *   4. Explicit glob probe for nvm/fnm/asdf/mise/volta/local — those
 *      version managers typically wire PATH from `.zshrc`/`.bashrc`,
 *      which `/bin/sh -l` does NOT source.
 *   5. `exec` propagates signals + exit codes. Replaces the shell so
 *      SIGTERM from the MCP host reaches the bundle/npx directly.
 *   6. Bundle runtime crashes propagate; no npx fallback after `exec
 *      "$BUNDLE"` succeeds. Silently retrying via npx would hide install
 *      corruption.
 *   7. `@latest` on the package spec is load-bearing: without it,
 *      `npa('@inkeep/open-knowledge')` parses as `type: 'range', spec: '*'`,
 *      which routes through `npm-pick-manifest`'s engine-aware sort. Users
 *      on a Node version older than the package's `engines.node` get
 *      silently downgraded to the highest engine-compatible version (often
 *      years-stale), with no warning. The `@latest` tag bypasses that
 *      filter and either returns the published latest or surfaces a loud
 *      `EBADENGINE`. `-y` suppresses the install-confirm prompt under
 *      non-TTY (MCP hosts are always non-TTY).
 *
 * The first line `# ok-mcp-v1` is both a shell comment and the version
 * sentinel checked by `isEntryUpToDate`. Bump the suffix (`v2`, `v3`, …)
 * on any structurally-different chain so reclaim recognizes stale text.
 *
 * `CHAIN_V1` / `CHAIN_VERSION_SENTINEL` are package-internal — exported
 * from this module for per-package tests, but DELIBERATELY NOT re-exported
 * from `packages/cli/src/index.ts`. Cross-package consumers should use
 * `buildManagedServerEntry()` to construct chain-shape entries and
 * `isEntryUpToDate()` to classify them — bytes are an implementation detail.
 */
/** @internal */
export const CHAIN_VERSION_SENTINEL = '# ok-mcp-v1';

/** @internal */
export const CHAIN_V1 = `# ok-mcp-v1
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

/** @internal */
export const CHAIN_WIN_VERSION_SENTINEL = '# ok-mcp-win-v1';

/**
 * Resilient chain (win v1) — the Windows member of the two-shape canonical
 * set. `powershell -NoProfile -NonInteractive -Command CHAIN_WIN_V1` resolves
 * a runtime at MCP-host spawn time: the npm-global `ok.cmd` shim first, then
 * `npx.cmd` from PATH, then explicit version-manager/installer dirs. No
 * bundle branches — OK Desktop does not ship on Windows, so `npm i -g
 * @inkeep/open-knowledge` is the primary install persona. That is also why
 * the pinned global shim outranks `npx @latest`: the MCP server and the `ok`
 * CLI the user runs by hand must resolve to the SAME installed version
 * (`@latest`-first would let them silently diverge).
 *
 * Each detail is empirically load-bearing:
 *   1. `powershell` (Windows PowerShell 5.1), not `cmd` and not `pwsh`.
 *      PowerShell 5.1 is preinstalled on every Windows box; PowerShell 7 is
 *      not. A `cmd /c` one-liner cannot carry this chain safely — cmd's
 *      quote/paren parsing does not follow the argument-quoting rules MCP
 *      hosts emit, and `rem` swallows the rest of its line, so the version
 *      sentinel could not survive as a comment.
 *   2. `-NoProfile` — profile scripts are arbitrary user code; skipping them
 *      keeps the spawn deterministic. `-NonInteractive` fails loud instead
 *      of blocking on a hidden prompt. Execution policy does not apply to
 *      `-Command`, so no `-ExecutionPolicy Bypass` is needed.
 *   3. Zero double-quote characters in the body (`Join-Path` + single-quoted
 *      literals only). The script travels as ONE argv element through the
 *      host's spawn-time Windows argument quoting; with no `"` in the text
 *      there is nothing for that quoting layer to mangle.
 *   4. The package spec is single-quoted — a bare leading `@` is
 *      PowerShell's splatting operator.
 *   5. `.cmd` shims only, never `.ps1` — invoking a `.ps1` would re-enter
 *      execution policy.
 *   6. `exit $LASTEXITCODE` after every runtime invocation. PowerShell has
 *      no `exec`; the shell stays parent, so propagating the child's exit
 *      code preserves the Unix chain's contract. Shutdown still works:
 *      `ok mcp` exits on stdin EOF and MCP hosts kill the process tree.
 *   7. Every env-var probe is null-guarded (`if ($env:X)`) — `Join-Path` on
 *      an unset variable raises a parameter-binding error rather than
 *      returning a path.
 *   8. The PATHEXT guard on line 2 is THE load-bearing line for GUI MCP
 *      hosts. Electron hosts (Claude Desktop) spawn servers with a
 *      constructed env that omits PATHEXT; the child then inherits a
 *      registry-fallback PATHEXT of just `.CPL`. Without `.CMD` in
 *      PATHEXT, PowerShell 5.1 treats `& <path>\ok.cmd` as a SILENT
 *      NO-OP — no error record, no output, `$LASTEXITCODE` stays null —
 *      so `exit $LASTEXITCODE` became `exit 0` and the host logged only
 *      "transport closed unexpectedly". Empirically pinned on a real
 *      Windows 11 VM by env-bisection; the guard prepends the standard
 *      executable extensions and leaves a sane PATHEXT untouched.
 *   9. The `Get-Command ok.cmd` PATH probe (after the APPDATA shim probe)
 *      covers hosts that scrub APPDATA but construct a PATH that includes
 *      the npm global dir — Claude Desktop builds exactly such a PATH.
 *
 * PATH is far less hostile here than on macOS (Windows GUI apps read PATH
 * from the registry, so `Get-Command npx.cmd` usually succeeds); the
 * explicit dir probes are belt-and-braces for PATH-less setups (installer
 * default, nvm-windows via `NVM_SYMLINK`, fnm, Volta, Scoop, pnpm).
 *
 * `@latest` on the npx package spec is load-bearing for the same
 * engine-filter reason documented on `CHAIN_V1`.
 *
 * The first line `# ok-mcp-win-v1` is both a PowerShell comment and the
 * version sentinel checked by `isEntryUpToDate`. Bump the suffix (`win-v2`,
 * …) on any structurally-different chain. Same `@internal` export rules as
 * `CHAIN_V1`.
 */
/** @internal */
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

/**
 * MCP install modes for `ok init`-written editor configs.
 *
 * - `'published'` (default) — the local platform's resilient chain shape:
 *   `{command: '/bin/sh', args: ['-l', '-c', CHAIN_V1]}` on macOS/Linux,
 *   `{command: 'powershell', args: ['-NoProfile', '-NonInteractive',
 *   '-Command', CHAIN_WIN_V1]}` on Windows.
 *   Resolves an installed runtime at spawn time. Byte-identical across all
 *   developer machines of the same platform; detect with `isEntryUpToDate`
 *   (which recognizes BOTH shapes on every platform).
 * - `'dev'` — `{command: 'node', args: [<dist/cli.mjs>, 'mcp'], env: {...}}`.
 *   Used by `--dev-mcp` for monorepo development against a worktree-local CLI.
 */
type McpInstallMode = 'published' | 'dev';

export interface McpInstallOptions {
  mode?: McpInstallMode;
  /**
   * Platform whose canonical chain shape to emit; defaults to
   * `process.platform`. Writers never set this — a machine always writes its
   * own platform's shape; tests inject it to pin either shape on any host.
   */
  platformName?: NodeJS.Platform;
  /**
   * Skip `writeEditorMcpConfig`'s `isEditorTargetAvailable` check. Default
   * `ok init` behavior rejects writes for editors whose config dir doesn't
   * exist — reasonable when the default editor list is being fanned out
   * without user intent. The Desktop consent dialog shows every editor with
   * a checkbox and the user explicitly toggles; their click IS the consent,
   * so the availability check would silently drop the selection.
   * `writeUserMcpConfigs` sets this to `true`; terminal-invoked `ok init`
   * never sets it.
   */
  skipAvailabilityCheck?: boolean;
}

/**
 * True iff the entry matches either platform's chain shape AND embeds that
 * shape's current version sentinel. Reclaim's no-op gate — only entries that
 * pass this check are left untouched. Foreign shapes (legacy bare-npx,
 * bundle-direct, arbitrary customizations, missing/malformed entries) all
 * resolve `false` and trigger a rewrite.
 *
 * BOTH platforms' canonical shapes are recognized on EVERY platform: a
 * committed project config (`.mcp.json`, `.cursor/mcp.json`, …) written on
 * one platform must classify as canonical on the other, or the two
 * platforms' startup reclaim sweeps would rewrite the shared file back and
 * forth forever. Writers always EMIT the local platform's shape; this
 * predicate only decides "leave it alone".
 *
 * The check is intentionally permissive on the chain body — the sentinel
 * version stamp is the only invariant. Future chain edits that don't change
 * the structural contract can keep the sentinel; structural edits (e.g.
 * adding a new probe branch that changes execution order) must bump that
 * platform's sentinel so existing-but-stale entries get rewritten.
 */
export function isEntryUpToDate(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;

  // Unix chain shape (claude / claude-desktop / cursor / codex):
  // `{ command: '/bin/sh', args: ['-l', '-c', CHAIN_V1] }`.
  if (e.command === '/bin/sh') {
    if (!Array.isArray(e.args)) return false;
    if (e.args[0] !== '-l' || e.args[1] !== '-c') return false;
    const body = e.args[2];
    return typeof body === 'string' && body.includes(CHAIN_VERSION_SENTINEL);
  }

  // Windows chain shape:
  // `{ command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', CHAIN_WIN_V1] }`.
  if (e.command === 'powershell') {
    if (!Array.isArray(e.args)) return false;
    if (e.args[0] !== '-NoProfile' || e.args[1] !== '-NonInteractive' || e.args[2] !== '-Command') {
      return false;
    }
    const body = e.args[3];
    return typeof body === 'string' && body.includes(CHAIN_WIN_VERSION_SENTINEL);
  }

  // OpenCode shape: `{ type: 'local', enabled, command: [...] }` — `command`
  // is a single argv array, no `args` key (see `buildOpenCodeEntry`).
  // Without this branch the repair/reclaim consumers that gate on
  // `isEntryUpToDate` (repair-mcp-configs, desktop mcp-wiring + project reclaim)
  // would treat every canonical OpenCode entry as stale and perpetually rewrite
  // it, emitting spurious `mcp-config-migrate` telemetry.
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

  return false;
}

export function resolveDevCliDistPath(entryPath: string = process.argv[1]): string {
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

  // Fresh array per call: editor writers may mutate the result (`{...config,
  // [topLevelKey]: {...existing, [serverName]: entry}}`) and TOML serializers
  // sometimes touch input nodes. Sharing a frozen literal would surface a
  // confusing TypeError downstream, while sharing an unfrozen literal would
  // turn an accidental writer mutation into cross-call drift. Construct
  // anew — the chain text is a single shared string by design (immutable).
  const platformName = options.platformName ?? process.platform;
  if (platformName === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', CHAIN_WIN_V1],
    };
  }
  return {
    command: '/bin/sh',
    args: ['-l', '-c', CHAIN_V1],
  };
}

/**
 * OpenCode's `opencode.json` uses a distinct entry shape from the chain-shape
 * editors: the server lives under the top-level `mcp` key, and each entry is a
 * typed object — `{ type: 'local', enabled, command }` — where `command` is a
 * SINGLE argv array, not a split `command` + `args`. We reuse the same `CHAIN_V1`
 * bootstrap (and the same dev-mode resolution) so the resolved server is
 * byte-identical to what `.mcp.json` / `.cursor/mcp.json` / `.codex/config.toml`
 * embed — only the JSON envelope differs. OpenCode names the env map
 * `environment` (not `env`).
 *
 * Fresh arrays/objects per call, for the same mutation-safety reason documented
 * on `buildManagedServerEntry`.
 *
 * Internal: only `EDITOR_TARGETS.opencode.buildEntry` calls this. Cross-package
 * consumers go through `target.buildEntry(...)`, so it is deliberately NOT
 * exported (an unused export would trip `knip`).
 */
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
    command: ['/bin/sh', '-l', '-c', CHAIN_V1],
  };
}

/**
 * Security gate for the docked-terminal Claude launch's MCP pre-approval.
 *
 * True iff `entry` is structurally IDENTICAL to one of OK's own canonical
 * PUBLISHED managed entries — the closed two-element set of the Unix shape
 * (`{command:'/bin/sh', args:['-l', '-c', CHAIN_V1]}`) and the Windows shape
 * (`{command:'powershell', args:[…, CHAIN_WIN_V1]}`) — with NO extra keys
 * (an injected `env` on either shape, a different `command`, an appended
 * chain line). Unlike {@link isEntryUpToDate} — deliberately permissive (sentinel
 * substring) for the reclaim flow — this is an EXACT match, so it is sound
 * as a trust boundary: a same-named `mcpServers["open-knowledge"]` entry in
 * a shared/cloned project's `.mcp.json` that points anywhere else (RCE via
 * `command`, tool-poisoning via a URL) fails this and is NOT pre-approved,
 * leaving Claude Code's own "trust this MCP server?" prompt in place.
 * Dev-mode and version-stale OK entries also fail (safe — the user simply
 * sees the prompt). The OTHER platform's canonical is accepted by design: it
 * is byte-exactly OK's own chain, and its interpreter NAME does not resolve
 * on this platform (`/bin/sh` does not exist on Windows; PowerShell Core on
 * macOS/Linux installs as `pwsh`, never `powershell`), so pre-approving it
 * grants nothing an attacker can use. That inertness is load-bearing: a
 * future canonical that names a cross-platform-resolvable interpreter must
 * either keep this gate sound or scope it per-platform.
 */
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
  // Exactly the canonical key set — any extra field (e.g. an injected `env`
  // on the Unix shape) means it is not OK's own entry, so refuse. Key-count
  // equality plus the per-key checks below pin the exact set.
  if (Object.keys(e).length !== Object.keys(canonical).length) return false;
  if (e.command !== canonical.command) return false;
  // `canonical` is OK's own output, but `buildManagedServerEntry` is typed
  // `Record<string, unknown>`; narrow with `Array.isArray` rather than an
  // unchecked cast, so a future shape change is caught by the compiler (and,
  // at runtime, degrades to `false` — the secure direction).
  const canonicalArgs = canonical.args;
  if (!Array.isArray(canonicalArgs) || !Array.isArray(e.args)) return false;
  if (e.args.length !== canonicalArgs.length) return false;
  return e.args.every((v, i) => v === canonicalArgs[i]);
}

export interface AppSupportOptions {
  home?: string;
  platformName?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function pathApiForPlatform(platformName: NodeJS.Platform) {
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
    return env.APPDATA ?? pathApi.join(home, 'AppData', 'Roaming');
  }

  return env.XDG_CONFIG_HOME ?? pathApi.join(home, '.config');
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

/**
 * OpenCode follows the XDG base-dir convention on every platform: its global
 * config lives at `$XDG_CONFIG_HOME/opencode/` (default `~/.config/opencode/`),
 * NOT under macOS `~/Library/Application Support`. On Windows it resolves
 * `%APPDATA%\opencode\` (by analogy with other XDG-on-Windows tools; verify
 * against OpenCode release notes before promoting in docs).
 */
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

/**
 * OpenClaw keeps its MCP config at a user-global `~/.openclaw/openclaw.json` on
 * every platform (the agent-gateway home dir), analogous to Cursor's
 * `~/.cursor/mcp.json`. Servers nest under `mcp.servers`.
 */
export function resolveOpenClawConfigPath(options: AppSupportOptions = {}): string {
  const platformName = options.platformName ?? process.platform;
  const home = options.home ?? homedir();
  return pathApiForPlatform(platformName).join(home, '.openclaw', 'openclaw.json');
}

export interface EditorMcpTarget {
  id: EditorId;
  /** Human-friendly name for CLI output. */
  label: string;
  /** Resolve the absolute path to the MCP config file. */
  configPath: (cwd: string, home?: string) => string;
  /** On-disk config format for this editor. */
  format: 'json' | 'toml';
  /** Top-level key that holds the server map. */
  topLevelKey: 'mcpServers' | 'servers' | 'mcp_servers' | 'mcp';
  /**
   * Optional second-level key nested under `topLevelKey` that holds the server
   * map, for editors whose config nests it one level deeper — OpenClaw keys
   * servers at `mcp.servers.<name>`. When set, the JSON upsert/read walk the
   * `[topLevelKey, serverMapSubKey, serverName]` path; when absent they use the
   * flat `[topLevelKey, serverName]` every other editor uses. JSON-only.
   */
  serverMapSubKey?: string;
  /**
   * When true, this editor is only ever written if its config root is present
   * (`detectPath` exists) — the availability check is enforced even in the
   * consent flow's `skipAvailabilityCheck` path. For a global agent gateway like
   * OpenClaw that most users don't run, writing `~/.openclaw/openclaw.json` for a
   * tool that isn't installed is pointless (nothing reads it), so it's gated on
   * detection everywhere. Editors without this flag keep the default behavior:
   * `ok init` gates on detection, but an explicit consent-dialog toggle writes.
   */
  offerOnlyWhenDetected?: boolean;
  /** Config key used for this project's MCP server entry. */
  serverName: (cwd: string) => string;
  /** Build the server entry object for this editor. */
  buildEntry: (cwd: string, options?: McpInstallOptions) => Record<string, unknown>;
  /** Whether the config is project-local or user-global. */
  scope: 'project' | 'global';
  /** Filesystem path whose existence implies the editor is installed. */
  detectPath?: (cwd: string, home?: string) => string;
  /** Project-local MCP config path (used for project-scope installs). */
  projectConfigPath?: (cwd: string) => string;
  /** Project-local Agent Skill entrypoint, when the editor has a known skill surface. */
  projectSkillPath?: (cwd: string) => string;
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
    // Codex reads CODEX_HOME (default ~/.codex) for user config; project-local
    // .codex/config.toml support was added by analogy with the other editors.
    // Verify against Codex CLI release notes before promoting in docs.
    projectConfigPath: (cwd) => join(cwd, '.codex', 'config.toml'),
    // Codex installs into its own `.codex/skills/<name>/` so "install on Codex
    // only" is honest. This is the second source for core's
    // `EDITOR_PROJECT_SKILL_ROOT` (codex) and must match it. Codex also reads
    // `.agents/skills/` as a generic store, but OK writes the primary dir.
    projectSkillPath: (cwd) => join(cwd, '.codex', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  opencode: {
    id: 'opencode',
    label: EDITOR_LABELS.opencode,
    configPath: (_cwd, home) => resolveOpenCodeConfigPath({ home }),
    format: 'json',
    // OpenCode keys MCP servers under a top-level `mcp` object (not
    // `mcpServers`), and each value is a `{ type: 'local', enabled, command }`
    // entry — see `buildOpenCodeEntry`.
    topLevelKey: 'mcp',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildOpenCodeEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => dirname(resolveOpenCodeConfigPath({ home })),
    projectConfigPath: (cwd) => join(cwd, 'opencode.json'),
    // OpenCode installs into its own `.opencode/skills/<name>/` (which it scans
    // natively, alongside `.agents/skills/` and `.claude/skills/`), so "install
    // on OpenCode only" is honest — no shared write with Codex. Second source
    // for core's `EDITOR_PROJECT_SKILL_ROOT` (opencode) and must match it.
    projectSkillPath: (cwd) => join(cwd, '.opencode', 'skills', 'open-knowledge', 'SKILL.md'),
  },
  openclaw: {
    id: 'openclaw',
    label: EDITOR_LABELS.openclaw,
    configPath: (_cwd, home) => resolveOpenClawConfigPath({ home }),
    format: 'json',
    // OpenClaw nests MCP servers under `mcp.servers` (two levels), each a
    // chain-shape `{command, args}` entry — the same resilient launcher
    // (`buildManagedServerEntry`) every other editor gets, so a resolved OK
    // server is byte-identical; only the JSON envelope + nesting differ.
    topLevelKey: 'mcp',
    serverMapSubKey: 'servers',
    serverName: () => MCP_SERVER_NAME,
    buildEntry: (_cwd, options) => buildManagedServerEntry(options),
    scope: 'global',
    detectPath: (_cwd, home) => join(home ?? homedir(), '.openclaw'),
    // Never write `~/.openclaw/openclaw.json` unless OpenClaw is actually
    // installed — gated on detection even under consent-flow skipAvailabilityCheck.
    offerOnlyWhenDetected: true,
  },
};

/**
 * Validate and resolve editor IDs to targets. Throws on unknown IDs.
 *
 * Uses `Object.hasOwn` (not `in`) to reject prototype-chain reads such as
 * `toString` or `__proto__`. With `in`, those would pass the membership
 * check, lookup would return `Object.prototype`'s function, and downstream
 * `target.configPath(...)` would crash with a confusing `TypeError`.
 */
export function resolveEditorTargets(ids: EditorId[]): EditorMcpTarget[] {
  const unknown = ids.filter((id) => !Object.hasOwn(EDITOR_TARGETS, id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown editor(s): ${unknown.join(', ')}. Valid options: ${ALL_EDITOR_IDS.join(', ')}`,
    );
  }
  return ids.map((id) => EDITOR_TARGETS[id]);
}
