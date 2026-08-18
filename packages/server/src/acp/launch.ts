/**
 * Resolve + spawn ACP agent processes.
 *
 * Security envelope (spec 2026-07-02-acp-external-agents §9): spawnable
 * commands come ONLY from (a) registry manifests (npx / uvx / binary
 * distribution specs) or (b) the machine-local custom-agents file. Nothing
 * arriving over HTTP/WS names a command — frames carry agent IDS which
 * resolve through this module. `shell: false` + argv arrays throughout.
 *
 * Never bundled, never redistributed: npx/uvx packages install into the
 * user's package-manager cache at launch time; binary archives download to
 * `~/.ok/acp-agents/<id>/<version>/` (user-level so N projects share one
 * install). Proprietary agents therefore stay entirely outside OK's GPL
 * distribution.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { constants, statSync } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { augmentAgentSpawnPath, OK_DIR, OK_HOSTED_AGENT_ENV } from '@inkeep/open-knowledge-core';
import { tracedMkdir, tracedRename, tracedRm } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';
import { downloadToFileWithSha, extractArchive, isWithin, sanitizeSegment } from './archive.ts';
import { mergeLoginShellPath } from './login-shell-path.ts';
import type { ManagedRuntime } from './managed-runtime.ts';
import type { CustomAgentEntry, RegistryAgent, RegistryBinaryTarget } from './registry.ts';

export interface ResolvedLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  kind: 'npx' | 'uvx' | 'binary' | 'custom';
  /**
   * True when this launch's PATH came from a manifest / custom-agent `env`
   * overlay rather than the repaired inherited base. Such a PATH is a spawn-env
   * contract that wins verbatim (see {@link mergedEnv}), so the login-shell
   * fallback must leave it alone — the same reason base augmentation does.
   */
  pathFromOverlay: boolean;
}

export class AgentLaunchError extends Error {
  readonly code:
    | 'unsupported-platform'
    | 'no-distribution'
    | 'install-failed'
    | 'command-not-found';
  constructor(code: AgentLaunchError['code'], message: string) {
    super(message);
    this.name = 'AgentLaunchError';
    this.code = code;
  }
}

/** User-level cache for extracted binary distributions. */
function defaultBinaryCacheDir(): string {
  return join(homedir(), OK_DIR, 'acp-agents');
}

/** True iff `dir` exists and is a directory (symlinks followed). */
function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the spawn env for an ACP agent / terminal: `process.env` with its PATH
 * repaired, then `overlay` applied on top.
 *
 * The PATH repair targets the INHERITED base only — a Dock/Finder-launched
 * Desktop inherits launchd's minimal PATH, so an agent CLI installed under a
 * package-manager global bin (`~/Library/pnpm`, `~/.bun/bin`, …) isn't found
 * even when it runs fine from a terminal. We append the well-known tool +
 * PM-global dirs, the same augmentation git spawns use. An overlay that sets
 * PATH is a spawn-env contract and wins verbatim (applied after): augmentation
 * repairs the base env, it does not transform caller intent — matching
 * `child_process` / Docker / systemd semantics.
 */
export function mergedEnv(overlay?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Drop pnpm's `npm_config_overrides` broadcast from the inherited base.
    // When OK Desktop runs via `pnpm dev`, pnpm flattens its
    // `pnpm-workspace.yaml` `overrides` block into `npm_config_overrides`
    // for every child, in pnpm's flat `parent>child` key shape. A nested
    // `npx exec …` (how npx-kind agents launch) hands that string to npm's
    // arborist, which rejects the flat key with
    // `npm error Override without name: <parent>><child>` and the launch
    // dies during initialize. Every other pnpm broadcast (`patched-
    // dependencies`, `shared-workspace-lockfile`, `strict-peer-
    // dependencies`, …) only surfaces as an `Unknown env config` warning,
    // so the scrub is targeted, not family-wide — env-only npm config the
    // user actually set (`npm_config_userconfig`, nerf-darted auth tokens
    // like `npm_config_//registry.example.com/:_authToken`) must reach the
    // spawned agent unchanged.
    if (k.toLowerCase() === 'npm_config_overrides') continue;
    base[k] = v;
  }
  base[pathKey(base)] = augmentAgentSpawnPath(envPath(base), {
    platform: process.platform,
    homeDir: homedir(),
    isDir,
    delimiter,
  });
  return { ...base, ...overlay };
}

/** True when `overlay` sets PATH under any spelling — see {@link ResolvedLaunch.pathFromOverlay}. */
export function overlaySetsPath(overlay?: Record<string, string>): boolean {
  return overlay !== undefined && Object.keys(overlay).some((k) => k.toLowerCase() === 'path');
}

/**
 * Stamp the hosted-agent marker onto an agent's spawn env.
 *
 * Applied at the spawn site rather than inside `mergedEnv` so it lands on
 * real agent launches only — the harness-availability probe builds its env
 * from `mergedEnv` too, and a throwaway `--version` check is not a hosted
 * agent. Applied AFTER the caller's overlay: whether OK is hosting this agent
 * is our fact about the launch, not a per-agent registry setting to override.
 *
 * The marker's reason for existing is the hop it survives: the agent we spawn
 * goes on to spawn its own `ok mcp` (from the harness's MCP config, which OK
 * does not control), and that process reads the marker to decide whether to
 * hand the agent a preview URL or steer it to `ok open`.
 */
export function withHostedAgentMarker(env: Record<string, string>): Record<string, string> {
  return { ...env, [OK_HOSTED_AGENT_ENV]: '1' };
}

/**
 * Resolve a registry agent to a spawnable command, downloading + extracting
 * a binary distribution when that's the only option. Preference order
 * npx → uvx → binary: package-manager launches self-update via the pinned
 * version in the manifest and need no archive plumbing.
 */
export async function resolveRegistryLaunch(
  agent: RegistryAgent,
  platformKey: string | null,
  log: PinoLogger,
  binaryCacheDir: string = defaultBinaryCacheDir(),
): Promise<ResolvedLaunch> {
  const dist = agent.distribution;
  if (dist.npx !== undefined) {
    return {
      cmd: 'npx',
      args: ['-y', dist.npx.package, ...(dist.npx.args ?? [])],
      env: mergedEnv(dist.npx.env),
      kind: 'npx',
      pathFromOverlay: overlaySetsPath(dist.npx.env),
    };
  }
  if (dist.uvx !== undefined) {
    return {
      cmd: 'uvx',
      args: [dist.uvx.package, ...(dist.uvx.args ?? [])],
      env: mergedEnv(dist.uvx.env),
      kind: 'uvx',
      pathFromOverlay: overlaySetsPath(dist.uvx.env),
    };
  }
  if (dist.binary !== undefined) {
    if (platformKey === null || dist.binary[platformKey] === undefined) {
      throw new AgentLaunchError(
        'unsupported-platform',
        `${agent.name} has no build for this platform`,
      );
    }
    const target = dist.binary[platformKey];
    const root = await ensureBinaryInstalled(agent.id, agent.version, target, binaryCacheDir, log);
    // `cmd` is relative to the archive root (e.g. `./dist-package/cursor-agent`).
    const cmd = resolve(root, target.cmd.replace(/\\/g, '/'));
    if (!isWithin(root, cmd)) {
      throw new AgentLaunchError(
        'install-failed',
        `${agent.name} manifest cmd escapes its archive`,
      );
    }
    return {
      cmd,
      args: [...(target.args ?? [])],
      env: mergedEnv(target.env),
      kind: 'binary',
      pathFromOverlay: overlaySetsPath(target.env),
    };
  }
  throw new AgentLaunchError('no-distribution', `${agent.name} has no supported distribution`);
}

export function resolveCustomLaunch(entry: CustomAgentEntry): ResolvedLaunch {
  return {
    cmd: entry.command,
    args: [...(entry.args ?? [])],
    env: mergedEnv(entry.env),
    kind: 'custom',
    pathFromOverlay: overlaySetsPath(entry.env),
  };
}

/**
 * Rewrite an npx/uvx launch to run through a runtime OK downloaded — used
 * when the system interpreter is absent. Swaps the command for the managed
 * tree's own `npx`/`uvx` (which behaves identically to the system one, so the
 * args carry over unchanged), prepends the runtime's bin dir to PATH so
 * nested `node`/`uv` resolve to the managed copy, and points the package
 * cache at a private dir so package installs never touch the user's global
 * `~/.npm` / uv cache. Only npx/uvx launches are rewritable — a binary or
 * custom command has no managed fallback.
 */
export function rewriteLaunchToManagedRuntime(
  launch: ResolvedLaunch,
  runtime: ManagedRuntime,
): ResolvedLaunch {
  const env = { ...launch.env };
  env[pathKey(env)] = prependPath(runtime.binDir, envPath(env));
  const pathFromOverlay = launch.pathFromOverlay;
  if (runtime.kind === 'node') {
    env.npm_config_cache = runtime.cacheDir;
    return { cmd: runtime.npxBin, args: [...launch.args], env, kind: 'npx', pathFromOverlay };
  }
  env.UV_CACHE_DIR = runtime.cacheDir;
  return { cmd: runtime.uvxBin, args: [...launch.args], env, kind: 'uvx', pathFromOverlay };
}

/**
 * Rewrite a launch to also search the login shell's PATH — used when the
 * inherited-plus-augmented PATH couldn't resolve the command but the user's
 * terminal can (a version manager whose bin dir no static list can name; see
 * `login-shell-path.ts`). Appended, never prepended, so every directory that
 * already resolved keeps resolving to the same binary.
 */
export function withLoginShellPath(launch: ResolvedLaunch, loginShellPath: string): ResolvedLaunch {
  return { ...launch, env: withLoginShellPathEnv(launch.env, loginShellPath) };
}

/**
 * {@link withLoginShellPath} for a bare spawn env — the ACP terminal surface,
 * which builds its env from `mergedEnv` rather than from a `ResolvedLaunch`.
 * Same append-only merge, same case-preserving PATH key.
 */
export function withLoginShellPathEnv(
  env: Record<string, string>,
  loginShellPath: string,
): Record<string, string> {
  const next = { ...env };
  next[pathKey(next)] = mergeLoginShellPath(envPath(next), loginShellPath, delimiter);
  return next;
}

/** The env's PATH key (Windows spells it `Path`), for case-preserving overwrite. */
function pathKey(env: Record<string, string>): string {
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === 'path') return k;
  }
  return 'PATH';
}

function prependPath(dir: string, existing: string | undefined): string {
  return existing !== undefined && existing !== '' ? `${dir}${delimiter}${existing}` : dir;
}

/**
 * Download + extract a binary distribution once per (id, version); later
 * launches reuse the extracted tree. Extraction lands in a temp dir first
 * and is renamed into place so a crash mid-extract never leaves a
 * half-populated version dir that would satisfy the fast-path check.
 */
async function ensureBinaryInstalled(
  id: string,
  version: string,
  target: RegistryBinaryTarget,
  cacheDir: string,
  log: PinoLogger,
): Promise<string> {
  const versionDir = join(cacheDir, sanitizeSegment(id), sanitizeSegment(version));
  try {
    const st = await stat(versionDir);
    if (st.isDirectory()) return versionDir;
  } catch {
    // Not installed yet.
  }

  log.info({ id, version, archive: target.archive }, '[acp-launch] downloading agent binary');
  const stagingDir = join(tmpdir(), `ok-acp-install-${process.pid}-${Date.now()}`);
  await tracedMkdir(stagingDir, { recursive: true });
  const isZip = /\.zip$/i.test(new URL(target.archive).pathname);
  const archivePath = join(stagingDir, isZip ? 'archive.zip' : 'archive.tar.gz');
  try {
    const sha = await downloadToFileWithSha(target.archive, archivePath, {
      signal: AbortSignal.timeout(120_000),
    });
    // Binary distributions are opaque executables — verify the publisher's
    // checksum whenever the manifest carries one, mirroring the managed-
    // runtime download path. A manifest without one installs with a loud
    // warning rather than silently skipping verification.
    if (target.sha256 !== undefined) {
      if (sha !== target.sha256.toLowerCase()) {
        throw new Error(`archive checksum mismatch: expected ${target.sha256}, got ${sha}`);
      }
    } else {
      log.warn(
        { id, version, archive: target.archive },
        '[acp-launch] manifest carries no sha256 for the binary archive — installing unverified',
      );
    }

    const extractDir = join(stagingDir, 'extracted');
    await tracedMkdir(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir, isZip);
    const cmdPath = resolve(extractDir, target.cmd.replace(/\\/g, '/'));
    if (!isWithin(extractDir, cmdPath)) {
      throw new Error('manifest cmd escapes the extracted archive');
    }
    await chmod(cmdPath, 0o755).catch(() => {
      // Windows / already-executable — non-fatal.
    });

    await tracedMkdir(join(cacheDir, sanitizeSegment(id)), { recursive: true });
    await tracedRm(versionDir, { recursive: true, force: true });
    await tracedRename(extractDir, versionDir);
    log.info({ id, version, versionDir }, '[acp-launch] agent binary installed');
    return versionDir;
  } catch (err) {
    throw new AgentLaunchError(
      'install-failed',
      `installing ${id}@${version} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await tracedRm(stagingDir, { recursive: true, force: true }).catch(() => {
      // Best-effort temp cleanup.
    });
  }
}

/**
 * Verify the resolved command is launchable BEFORE spawning, so a missing
 * interpreter surfaces as an actionable "install X" message instead of the
 * child's asynchronous, opaque `spawn <cmd> ENOENT` (which today lands as a
 * generic `spawn-failed` / `agent failed to start` status).
 *
 * `npx`/`uvx`/a bare custom command are searched across `PATH` the way the OS
 * would — honoring `PATHEXT` on Windows, where `npx` is really `npx.cmd`. A
 * path-qualified command (binary distributions, path-qualified custom agents)
 * is checked in place. Throws `AgentLaunchError('command-not-found')` with a
 * per-kind remediation hint when nothing is executable.
 */
export async function preflightLaunch(launch: ResolvedLaunch): Promise<void> {
  if (await isLaunchable(launch.cmd, envPath(launch.env))) return;
  throw new AgentLaunchError('command-not-found', missingCommandHint(launch));
}

function missingCommandHint(launch: ResolvedLaunch): string {
  switch (launch.kind) {
    case 'npx':
      return `\`${launch.cmd}\` was not found. This agent runs through npx, which ships with Node.js — install Node.js (https://nodejs.org) and make sure it is on your PATH.`;
    case 'uvx':
      return `\`${launch.cmd}\` was not found. This agent runs through uvx, which ships with uv — install uv (https://docs.astral.sh/uv/getting-started/installation/) and make sure it is on your PATH.`;
    case 'binary':
      return `the agent binary at ${launch.cmd} is missing or not executable.`;
    case 'custom':
      return `\`${launch.cmd}\` was not found on your PATH. A desktop app launched from the Dock or Finder doesn't inherit your shell's PATH, so an agent installed only in a shell-configured location won't be visible here — use an absolute path to the command, or install it to a standard location.`;
  }
}

/**
 * The launch-error detail for an npx/uvx interpreter that is installed but
 * cannot RUN (see {@link probeInterpreterHealth}). Reaches the user on either
 * dead end: a host with no managed runtime to fall back to, or a managed
 * runtime the user declined. Distinct from {@link missingCommandHint}: the
 * command is right there, so a "was not found" message sends the user hunting
 * for an install they already have.
 */
export function brokenInterpreterHint(launch: ResolvedLaunch, detail: string): string {
  // Switched whole, like `missingCommandHint`: the Homebrew/icu4c cause is
  // Node-specific, and pasting it into a uv failure sends that user to inspect
  // a runtime with nothing to do with it — the wrong-address problem this hint
  // exists to fix.
  const cause =
    launch.kind === 'uvx'
      ? 'That usually means its uv is broken. Reinstall or repair uv and try again.'
      : 'That usually means its Node.js is broken — on macOS a common cause is a Homebrew `node` whose `icu4c` library was upgraded out from under it. Reinstall or repair Node.js and try again.';
  return `\`${launch.cmd}\` is installed but failed to run (${detail}). ${cause}`;
}

/**
 * The launch-error detail for a REPLACED copy of OK's own runtime still
 * failing to run — the fallback's fallback, after the damaged copy was
 * discarded and re-downloaded. Deliberately not {@link brokenInterpreterHint}:
 * a verified archive that won't run twice in a row is not a broken system
 * Node/uv, so pointing at Homebrew would send the user to repair something
 * blameless.
 */
export function unrepairableManagedRuntimeHint(launch: ResolvedLaunch, detail: string): string {
  const runtime = launch.kind === 'uvx' ? 'uv' : 'Node.js';
  return `OK downloaded a fresh copy of ${runtime} and it still can't run (${detail}). Something on this machine is stopping it — antivirus, a security policy, or an unsupported CPU are the usual causes.`;
}

/**
 * The launch-error detail for a damaged copy of OK's own runtime that could
 * not be replaced: the rename that clears the way for a fresh download failed,
 * which on Windows means another agent still holds files open inside the tree.
 * Distinct from {@link unrepairableManagedRuntimeHint} because nothing was
 * re-downloaded — claiming a fresh copy also failed would name the wrong
 * culprit and send the user hunting for a machine-level cause that isn't there.
 */
export function undeletableManagedRuntimeHint(launch: ResolvedLaunch, detail: string): string {
  const runtime = launch.kind === 'uvx' ? 'uv' : 'Node.js';
  return `OK's own copy of ${runtime} is damaged (${detail}) and couldn't be replaced — another agent may still be using it. Close other agent threads and try again.`;
}

/**
 * The launch-error detail for a user who declined the re-download of OK's own
 * damaged runtime. Not the stock decline hint: that one says the interpreter
 * isn't installed, when the actual state is that OK's copy is present and
 * broken and the user just refused the fix.
 */
export function declinedRepairHint(launch: ResolvedLaunch): string {
  const runtime = launch.kind === 'uvx' ? 'uv' : 'Node.js';
  return `OK's own copy of ${runtime} is damaged and can't run this agent. Start the agent again to let OK download a fresh copy.`;
}

/** Cap on probe stderr retained while waiting for the verdict. */
const PROBE_STDERR_MAX = 2_000;
/** Cap on the stderr excerpt carried in a probe verdict (it reaches the user). */
const PROBE_DETAIL_MAX = 300;

/**
 * Confirm a resolved npx/uvx interpreter can actually EXECUTE, by running it
 * with `--version`.
 *
 * {@link preflightLaunch} proves only that the command file exists and carries
 * the execute bit — which a fatally broken interpreter also does. A Homebrew
 * `node` whose linked `icu4c` was upgraded out from under it aborts the instant
 * it starts (`dyld: Library not loaded: …/libicui18n.NN.dylib` → SIGABRT), so
 * the agent dies before the ACP handshake and the user sees only
 * `initialize failed: ACP connection closed`. Catching it here lets the caller
 * route to the managed runtime — the same remedy a MISSING interpreter already
 * gets.
 *
 * Returns a short failure detail (signal or exit code, plus the first stderr
 * line) when the probe crashes or exits non-zero, and `null` when it runs
 * cleanly. A probe still alive at `timeoutMs` also counts as `null`: a slow
 * `--version` is not the crash-on-startup this guards, and blocking every
 * launch on it would be a worse regression than letting the real spawn proceed.
 * `--version` is universal to npx/uvx, fast, network-free and side-effect-free
 * (no package install). Spawned the way {@link spawnAcpAgent} spawns the real
 * agent — same Windows command resolution, same `launch.env` — so the probe
 * exercises the interpreter the launch actually will.
 */
export function probeInterpreterHealth(
  launch: ResolvedLaunch,
  timeoutMs = 5_000,
  log?: PinoLogger,
): Promise<string | null> {
  const win = process.platform === 'win32';
  const resolved = win ? resolveWindowsCommand(launch.cmd, envPath(launch.env)) : launch.cmd;
  const wrap = win && /\.(cmd|bat)$/i.test(resolved);
  const { cmd, args } = wrap
    ? windowsCmdWrap(resolved, ['--version'])
    : { cmd: resolved, args: ['--version'] };
  return new Promise((settleProbe) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        env: launch.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
        // Same reason as the real agent spawn: an interpreter that hangs has
        // usually already forked, and only a process GROUP kill reaches the
        // fork. Without this a timed-out probe leaks the grandchild.
        detached: !win,
        windowsHide: true,
        windowsVerbatimArguments: wrap,
      });
    } catch (err) {
      settleProbe(err instanceof Error ? err.message : String(err));
      return;
    }
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < PROBE_STDERR_MAX) stderr += chunk;
    });
    let settled = false;
    const settle = (detail: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleProbe(detail);
    };
    const timer = setTimeout(() => {
      // Group kill, not `child.kill`: an npx that hangs has usually already
      // forked, and signalling only the wrapper leaves the fork running.
      terminateAgentTree(child, { graceMs: 0, forceWaitMs: 0 }).catch(() => {
        // Best-effort: the verdict below stands either way.
      });
      // A timeout answers "healthy enough" and is otherwise indistinguishable
      // from a clean run, so without this line an interpreter that hangs every
      // launch spends the full budget invisibly and the operator sees only the
      // downstream handshake failure.
      log?.debug(
        { cmd: launch.cmd, kind: launch.kind, timeoutMs },
        '[acp-launch] interpreter health probe timed out — proceeding with the launch',
      );
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => settle(err.message));
    child.on('exit', (code, signal) => {
      if (signal === null && (code === null || code === 0)) {
        settle(null);
        return;
      }
      const firstStderrLine = stderr
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '');
      const reason = signal ?? `exit code ${code}`;
      settle(
        firstStderrLine !== undefined
          ? `${reason}: ${firstStderrLine.slice(0, PROBE_DETAIL_MAX)}`
          : reason,
      );
    });
  });
}

/** Case-insensitive `PATH` lookup (Windows spells it `Path`), falling back to the process env. */
export function envPath(env: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === 'path') return v;
  }
  return process.env.PATH;
}

/**
 * True when `cmd` names a location rather than a name to search for — binary
 * distributions and path-qualified custom agents. Such a command is checked in
 * place, so no amount of PATH repair changes its verdict.
 */
export function isPathQualified(cmd: string): boolean {
  const win = process.platform === 'win32';
  return isAbsolute(cmd) || cmd.includes('/') || (win && cmd.includes('\\'));
}

/** Resolve `cmd` to an executable the way the OS would at spawn time. */
async function isLaunchable(cmd: string, pathEnv: string | undefined): Promise<boolean> {
  const win = process.platform === 'win32';
  if (isPathQualified(cmd)) {
    return isExecutableFile(cmd);
  }
  const exts = win
    ? [
        '',
        ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.trim())
          .filter((e) => e !== ''),
      ]
    : [''];
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      if (await isExecutableFile(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const st = await stat(candidate);
    if (!st.isFile()) return false;
    // Windows has no execute bit; a matching PATHEXT entry (already applied by
    // the caller) is the executability signal there.
    if (process.platform === 'win32') return true;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare Windows command to its absolute launcher via PATH + PATHEXT,
 * searching only executable extensions (`.EXE`/`.CMD`/…) — never the bare file.
 * `C:\Program Files\nodejs` ships both an extensionless `npx` (a git-bash shell
 * script Windows can't exec) and `npx.cmd`; resolving to the real `npx.cmd` is
 * what lets it launch, and it fixes npm's `%~dp0` too (invoking `npx.cmd` by
 * its absolute path resolves its own dir correctly, where a quoted bare `"npx"`
 * resolves it to the cwd). Returns the input unchanged when already
 * path-qualified or unresolved. VM-verified against real `npx`.
 */
export function resolveWindowsCommand(cmd: string, pathEnv: string | undefined): string {
  if (isAbsolute(cmd) || cmd.includes('\\') || cmd.includes('/')) return cmd;
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not this candidate.
      }
    }
  }
  return cmd;
}

/** Double-quote a token if cmd.exe would otherwise split or interpret it. */
function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  return /[\s"&()<>^|%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * On Windows, route a `.cmd`/bare launcher through `cmd.exe /d /s /c`. The
 * whole command is wrapped in an OUTER pair of quotes (`cmd /c ""exe" args"`)
 * because `/s` strips the first and last quote — without it a launcher path
 * containing a space (e.g. `C:\Program Files\nodejs\npx.cmd`) is mis-split by
 * cmd. Passed verbatim so we, not Node, own the quoting. Args come only from
 * the trusted registry/custom sources (spec §9), and double-quoting neutralizes
 * cmd metacharacters for the package-name/flag arguments in practice.
 * VM-verified: real `npx` runs and bidirectional stdio (the ACP handshake)
 * round-trips through the wrapper.
 */
export function windowsCmdWrap(cmd: string, args: string[]): { cmd: string; args: string[] } {
  const inner = [`"${cmd}"`, ...args.map(quoteCmdArg)].join(' ');
  return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${inner}"`] };
}

/**
 * Spawn the resolved agent. Its lifetime is owned by its thread (killed on
 * thread close and on server shutdown), the opposite of the fire-and-forget
 * `spawn-detached.ts` handoff path.
 *
 * POSIX spawns are `detached: true` for group-kill, NOT for independence:
 * npx/uvx launches make the real agent a *grandchild*, and SIGKILL cannot be
 * forwarded by a dead wrapper — killing only the direct child orphans a
 * stuck agent mid-LLM-turn (verified: SIGKILL to `npx` leaves its bin
 * running, reparented to PID 1). `detached` makes the wrapper a process-group
 * leader so `terminateAgentTree` can signal the whole tree at once.
 *
 * On Windows, Node can't spawn a `.cmd`/`.bat` with `shell: false`
 * (CVE-2024-27980) and does no PATHEXT resolution for bare names — so a bare
 * launcher (system `npx`) is resolved to its absolute `npx.cmd` and any
 * `.cmd`/`.bat` is run through cmd.exe. Native `.exe`s (`uvx`, agent binaries,
 * the managed node) spawn directly. `taskkill /T` still reaps the whole tree.
 */
export function spawnAcpAgent(launch: ResolvedLaunch, cwd: string): ChildProcess {
  if (!isAbsolute(cwd)) {
    throw new Error(`spawnAcpAgent requires an absolute cwd, got: ${cwd}`);
  }
  const win = process.platform === 'win32';
  const resolved = win ? resolveWindowsCommand(launch.cmd, envPath(launch.env)) : launch.cmd;
  const wrap = win && /\.(cmd|bat)$/i.test(resolved);
  const { cmd, args } = wrap
    ? windowsCmdWrap(resolved, launch.args)
    : { cmd: resolved, args: launch.args };
  return spawn(cmd, args, {
    cwd,
    env: withHostedAgentMarker(launch.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: !win,
    windowsHide: true,
    // We built the cmd.exe command line ourselves (outer-quoted for spaced
    // paths); tell Node not to re-quote it.
    windowsVerbatimArguments: wrap,
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolve true when the child exits within `timeoutMs`, false otherwise. */
function awaitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

/** Signal the agent's whole process group, falling back to the direct child. */
function signalAgentGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // No such group (already gone) or the spawn predates group leadership —
    // fall back to the direct child.
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * Kill the agent and everything it spawned, and only resolve once it is
 * actually dead (or `false` if it somehow survived SIGKILL). POSIX: group
 * SIGTERM → `graceMs` wait → group SIGKILL. Windows: `taskkill /T /F`
 * immediately — there is no graceful console signal to try first, and a
 * TerminateProcess on the root would orphan the tree before taskkill could
 * enumerate it.
 */
export async function terminateAgentTree(
  child: ChildProcess,
  opts: { graceMs: number; forceWaitMs?: number },
): Promise<boolean> {
  const forceWaitMs = opts.forceWaitMs ?? 2_000;
  if (hasExited(child)) return true;
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        }).unref();
      } catch {
        // taskkill unavailable — degrade to the direct child.
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    return awaitExit(child, Math.max(opts.graceMs, forceWaitMs));
  }
  signalAgentGroup(child, 'SIGTERM');
  if (await awaitExit(child, opts.graceMs)) return true;
  signalAgentGroup(child, 'SIGKILL');
  return awaitExit(child, forceWaitMs);
}
