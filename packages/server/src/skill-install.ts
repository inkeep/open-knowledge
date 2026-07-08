import { type SpawnOptions, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  type BuildSkillZipResult,
  buildSkillZip,
  resolveBundledSkillDir,
} from './build-skill-zip.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { tracedMkdir } from './fs-traced.ts';
import { BUNDLE_SKILL_NAME, type BundleId } from './skill-bundles.ts';
import { recordSkillInstallEvent, type SkillInstallEventOutcome } from './skill-install-events.ts';
import {
  readServerPackageVersion,
  readTargetRecordedAt,
  readTargetVersion,
  type SkillStateLogger,
  type SkillStateSurface,
  writeTargetVersion,
} from './skill-state.ts';

/**
 * Minimal logger duck-type accepted by `installUserSkill`. Compatible with
 * `PinoLogger` (`warn(data, message)`) and ad-hoc console-style shims.
 *
 * Aliased to `SkillStateLogger` so the legacy-sidecar migrator and the
 * install-track logic share one shape.
 */
export type SkillInstallLogger = SkillStateLogger;

/**
 * Minimal signature of `node:child_process`'s `spawn` — the subset this
 * module actually calls. Injectable so unit tests can replace with a
 * deterministic fake subprocess.
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  opts: SpawnOptions,
) => ReturnType<typeof spawn>;

export interface InstallUserSkillOptions {
  /**
   * Override `$HOME`. The per-target install-state lives in
   * `${home}/.ok/skill-state.yml` under target key `cli-hosts`.
   * `HOME` env var is also overridden for the `npx skills` subprocess so it
   * writes per-host skill copies under the overridden home. Tests pass a tmpdir
   * here.
   */
  home?: string;
  /** Optional logger. Falls back to `console.warn` / `console.info`. */
  logger?: SkillInstallLogger;
  /**
   * Inject a `spawn`-like function for unit tests. Defaults to `node:child_process#spawn`.
   * Production callers never pass this.
   */
  spawn?: SpawnLike;
  /**
   * Subprocess timeout in milliseconds. Defaults to 60_000 (60 s). Tests
   * may lower this for faster coverage.
   */
  timeoutMs?: number;
  /**
   * Install-source attribution recorded on the per-target YAML entry.
   * Defaults to `'cli-npx-skills-add'` for the CLI / `ok init` path. The
   * Electron desktop main-process direct-invoke site (`packages/desktop/
   * src/main/index.ts` first-launch flow) passes `'desktop-direct'` to
   * distinguish it from a user-typed `ok init`.
   */
  surface?: SkillStateSurface;
  /**
   * Override the detected platform. Defaults to `process.platform`. On
   * `'win32'` the `npx` subprocess is spawned with `shell:true` (see
   * `runSpawn`). Tests inject `'win32'` to assert the `.cmd` shim path without
   * a real Windows host.
   */
  platform?: NodeJS.Platform;
  /**
   * Which user-global bundle to install. Defaults to `'discovery'` so existing
   * callers (and the `ok init` discovery leg) are unchanged; `ok init` calls
   * once per enabled bundle. The central-dir gate + resolve key off
   * `BUNDLE_SKILL_NAME[bundleId]`.
   */
  bundleId?: BundleId;
  /**
   * Bypass the version fast-path and always run the install. `ok init` sets
   * this because it loops `installUserSkill` once per bundle over the SHARED
   * `cli-hosts` version key: the first bundle's version write would otherwise
   * satisfy the second bundle's `skip-current` gate, freezing the second
   * bundle's content at its stale on-disk version on an upgrade-then-reinit.
   * `ok init` is explicit and infrequent, so always installing is cheap and
   * correct. The background sweep keeps its own batch-level fast-path.
   */
  force?: boolean;
}

export type InstallUserSkillResult = 'installed' | 'skip-current' | 'failed';

/**
 * Pre-split user-global skill name. The legacy migration removes any install
 * under this name before the new `discovery` bundle lands. Sibling constant:
 * `LEGACY_SKILL_DIR_NAME` in `packages/desktop/src/main/skill-reclaim.ts`
 * (kept separate so the desktop module stays free of server imports).
 */
const LEGACY_USER_SKILL_NAME = 'open-knowledge';

/**
 * Host dirs that may carry a pre-split `open-knowledge` user-global skill —
 * the `--copy`-mode install targets. Mirrors the desktop reclaim's host set.
 */
const LEGACY_USER_SKILL_HOST_DIRS = ['.claude', '.cursor', '.agents'] as const;

/** Pinned patch-range for the `skills` CLI. */
const SKILLS_CLI_SPEC = 'skills@~1.5.0';

/** Subprocess timeout default. */
const DEFAULT_TIMEOUT_MS = 60_000;

function centralSkillDir(home: string, bundleName: string): string {
  return join(home, '.agents', 'skills', bundleName);
}

async function centralSkillExists(home: string, bundleName: string): Promise<boolean> {
  try {
    const info = await stat(centralSkillDir(home, bundleName));
    return info.isDirectory();
  } catch {
    return false;
  }
}

interface SpawnOutcome {
  kind: 'ok' | 'nonzero' | 'timeout' | 'spawn-error';
  exitCode?: number | null;
  stderr: string;
  error?: Error;
}

/**
 * Quote one argv token for Windows `cmd.exe` when spawning with `shell:true`.
 * cmd.exe joins the argv into a single command line and splits on whitespace,
 * ignoring argv boundaries, so a whitespace-bearing token (notably the skill
 * dir under a `C:\Users\<name with space>` home) must be double-quoted to
 * survive as one argument. Whitespace-free tokens pass through untouched so a
 * flag like `*` reaches `npx` literally.
 */
export function quoteForWindowsShell(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

function runSpawn(
  spawnFn: SpawnLike,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    // On Windows `npx` resolves to `npx.cmd`; Node's `spawn` refuses to exec a
    // `.cmd`/`.bat` without a shell (hardened by CVE-2024-27980) and throws
    // ENOENT. `shell:true` routes through cmd.exe instead — but cmd.exe does
    // not re-quote argv, so whitespace-bearing args are quoted by us first.
    const useShell = platform === 'win32';
    const spawnArgs = useShell ? args.map(quoteForWindowsShell) : args;
    try {
      child = spawnFn(
        command,
        spawnArgs,
        withHiddenWindowsConsole({
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(useShell ? { shell: true } : {}),
        }),
      );
    } catch (err) {
      resolve({ kind: 'spawn-error', stderr: '', error: err as Error });
      return;
    }

    let stderr = '';
    let settled = false;
    const settle = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      // ENOENT on `npx` itself surfaces here.
      settle({ kind: 'spawn-error', stderr, error: err });
    });

    child.on('exit', (code) => {
      if (code === 0) settle({ kind: 'ok', exitCode: code, stderr });
      else settle({ kind: 'nonzero', exitCode: code, stderr });
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      settle({ kind: 'timeout', stderr });
    }, timeoutMs);
  });
}

/**
 * True when any pre-split `open-knowledge` user-global skill dir is on disk.
 * Gates the subprocess-spawning `npx skills remove` so a fresh machine with
 * nothing to migrate pays no `npx` cost — mirrors the desktop reclaim's
 * `existsSync` gate in `skill-reclaim.ts`.
 */
async function anyLegacyUserSkillExists(home: string): Promise<boolean> {
  for (const hostDir of LEGACY_USER_SKILL_HOST_DIRS) {
    try {
      const info = await stat(join(home, hostDir, 'skills', LEGACY_USER_SKILL_NAME));
      if (info.isDirectory()) return true;
    } catch {
      /* absent — keep checking the remaining hosts */
    }
  }
  return false;
}

/**
 * Legacy migration: remove any pre-split user-global `open-knowledge` skill
 * install before the new `discovery` bundle lands. No-op (no subprocess) when
 * no legacy dir is on disk — a fresh machine pays no `npx` cost. Fail-soft:
 * `npx skills remove` of an absent skill is expected to exit 0, but the
 * outcome is not load-bearing — non-zero exit / timeout / spawn error is
 * logged and swallowed. The subsequent `add` is what the install gates on.
 */
async function removeLegacyUserSkill(
  home: string,
  spawnFn: SpawnLike,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  logger: SkillInstallLogger,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!(await anyLegacyUserSkillExists(home))) return;
  const args = ['-y', SKILLS_CLI_SPEC, 'remove', '--agent', '*', '-g', LEGACY_USER_SKILL_NAME];
  const outcome = await runSpawn(spawnFn, 'npx', args, env, timeoutMs, platform);
  if (outcome.kind !== 'ok') {
    logger.warn(
      {
        event: 'skill-install.legacy-remove-failed',
        reason: outcome.kind,
        exitCode: outcome.exitCode,
        stderr: outcome.stderr,
      },
      'Legacy `open-knowledge` skill removal did not exit cleanly; continuing with install.',
    );
  }
}

/**
 * Install OpenKnowledge's user-global Agent Skill to every detected agent host.
 *
 * Installs the SLIM `discovery` bundle only — the rich `project` bundle never
 * lands at user scope; it ships project-local via `ok init`'s
 * `writeProjectSkill`. Each invocation first removes any pre-split
 * `open-knowledge` user-global install (fail-soft) then runs
 * `npx skills@~1.5.0 add <discovery-dir> --agent '*' -g -y --copy`.
 *
 * Idempotency: the `cli-hosts` entry in `${home}/.ok/skill-state.yml` gates
 * re-install. The subprocess is NOT invoked (and `'skip-current'` is returned)
 * only when BOTH the recorded version matches the current
 * `@inkeep/open-knowledge-server` package version AND the central skill
 * directory at `${home}/.agents/skills/open-knowledge-discovery` is still on
 * disk. The disk-presence check exists because a manual `npx skills remove -g`
 * (or equivalent rm) leaves the state file untouched, which would otherwise
 * wedge the next `ok init` into a no-op despite the skill being gone.
 *
 * Always resolves (never throws). Non-zero exit, timeout, or spawn error on
 * the `add` logs a warning via `opts.logger` (or `console.warn`) and returns
 * `'failed'`.
 */
export async function installUserSkill(
  opts: InstallUserSkillOptions = {},
): Promise<InstallUserSkillResult> {
  const home = opts.home ?? homedir();
  const logger: SkillInstallLogger = opts.logger ?? {
    warn: (data, message) => console.warn(message, data),
    info: (data, message) => console.info(message, data),
  };
  const spawnFn = opts.spawn ?? (spawn as SpawnLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const surfaceAttribution: SkillStateSurface = opts.surface ?? 'cli-npx-skills-add';
  const platform = opts.platform ?? process.platform;
  const bundleId = opts.bundleId ?? 'discovery';
  const bundleName = BUNDLE_SKILL_NAME[bundleId];

  const report = async (
    outcome: SkillInstallEventOutcome,
    version?: string,
    reason?: string,
  ): Promise<void> => {
    await recordSkillInstallEvent(
      {
        ts: new Date().toISOString(),
        surface: surfaceAttribution,
        target: 'cli-hosts',
        bundle: bundleId,
        outcome,
        ...(version !== undefined ? { version } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
      { homedir: () => home, warn: logger.warn },
    );
  };

  let currentVersion: string;
  try {
    currentVersion = await readServerPackageVersion();
  } catch (err) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'version-read-failed', error: String(err) },
      'Skill install aborted — could not read @inkeep/open-knowledge-server version.',
    );
    await report('failed', undefined, 'version-read-failed');
    return 'failed';
  }

  const existingVersion = await readTargetVersion(home, 'cli-hosts', logger).catch((err) => {
    // readTargetVersion re-throws non-ENOENT errors (EACCES, EIO, …); log
    // them here so persistent permission/IO issues on `~/.ok/skill-state.yml`
    // don't go invisible. Parse / schema-violation cases fire structured
    // warnings from inside `readSkillStateFile` via the threaded logger.
    logger.warn(
      { event: 'skill-install.gate.read-failed', error: String(err) },
      'Could not read cli-hosts install-state; proceeding with fresh install.',
    );
    return null;
  });
  if (!opts.force && existingVersion !== null && existingVersion === currentVersion) {
    if (await centralSkillExists(home, bundleName)) {
      logger.info?.(
        { event: 'skill-install.skip-current', version: currentVersion },
        'OpenKnowledge skill already installed at current version; skipping.',
      );
      await report('skip-current', currentVersion);
      return 'skip-current';
    }
    logger.info?.(
      {
        event: 'skill-install.reinstall-missing',
        version: currentVersion,
        path: centralSkillDir(home, bundleName),
      },
      'Sidecar matches current version but skill files are missing; reinstalling.',
    );
  }

  let bundleDir: string;
  try {
    // checkDesktop:false — the user-global install never auto-points at a
    // co-installed OK Desktop's bundle.
    bundleDir = resolveBundledSkillDir(bundleId, { checkDesktop: false });
  } catch (err) {
    logger.warn(
      {
        event: 'skill-install.failed',
        reason: 'bundled-asset-missing',
        error: String(err),
      },
      'Skill install aborted — bundled SKILL.md asset not found.',
    );
    await report('failed', currentVersion, 'bundled-asset-missing');
    return 'failed';
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };

  // Drop any pre-split `open-knowledge` user-global install first (no-op on a
  // fresh machine). Fail-soft — the `add` below is what the install gates on.
  await removeLegacyUserSkill(home, spawnFn, env, timeoutMs, logger, platform);

  // Install the bundle to every detected agent host.
  const args = ['-y', SKILLS_CLI_SPEC, 'add', bundleDir, '--agent', '*', '-g', '-y', '--copy'];
  const outcome = await runSpawn(spawnFn, 'npx', args, env, timeoutMs, platform);

  if (outcome.kind === 'ok') {
    try {
      await writeTargetVersion(home, 'cli-hosts', currentVersion, surfaceAttribution, logger);
    } catch (err) {
      logger.warn(
        { event: 'skill-install.failed', reason: 'sidecar-write-failed', error: String(err) },
        'Skill install succeeded but sidecar write failed.',
      );
      await report('failed', currentVersion, 'sidecar-write-failed');
      return 'failed';
    }
    logger.info?.(
      { event: 'skill-install.installed', version: currentVersion },
      'OpenKnowledge skill installed to detected agent hosts.',
    );
    await report('installed', currentVersion);
    return 'installed';
  }

  if (outcome.kind === 'timeout') {
    logger.warn(
      { event: 'skill-install.failed', reason: 'timeout', timeoutMs, stderr: outcome.stderr },
      'Skill install subprocess timed out. Run manually: npx ' +
        `${SKILLS_CLI_SPEC} add ${bundleDir} --agent '*' -g -y --copy`,
    );
    await report('failed', currentVersion, 'timeout');
    return 'failed';
  }

  if (outcome.kind === 'spawn-error') {
    logger.warn(
      {
        event: 'skill-install.failed',
        reason: 'spawn-error',
        error: String(outcome.error),
        stderr: outcome.stderr,
      },
      'Skill install failed — `npx` unavailable or spawn errored. Run manually: npx ' +
        `${SKILLS_CLI_SPEC} add ${bundleDir} --agent '*' -g -y --copy`,
    );
    await report('failed', currentVersion, 'spawn-error');
    return 'failed';
  }

  // nonzero
  logger.warn(
    {
      event: 'skill-install.failed',
      reason: 'nonzero-exit',
      exitCode: outcome.exitCode,
      stderr: outcome.stderr,
    },
    'Skill install subprocess exited non-zero. Run manually: npx ' +
      `${SKILLS_CLI_SPEC} add ${bundleDir} --agent '*' -g -y --copy`,
  );
  await report('failed', currentVersion, `nonzero-exit:${outcome.exitCode ?? 'unknown'}`);
  return 'failed';
}

// ─── Claude Desktop install (.skill file + OS file association) ────────────
//
// Distinct surface from `installUserSkill` above (which targets Claude
// CLI / Cursor / Codex via `npx skills add`). This path produces an
// `openknowledge.skill` zip and hands it to the OS so Claude Desktop's native
// install dialog takes over. Shared consumers: `ok install-skill` CLI,
// `POST /api/install-skill`. The Electron `okDesktop.skill.buildAndOpen`
// bridge has its OWN implementation in
// `packages/desktop/src/main/ipc/install-skill.ts` — it imports
// `buildSkillZip` directly and uses Electron's `app.getPath('downloads')` +
// `shell.openPath`. Both call sites read/write the shared `claude-cowork`
// entry in `~/.ok/skill-state.yml` via helpers in `skill-state.ts` so the
// click-time gate covers both surfaces.

const DOWNLOADS_DIR = 'Downloads';
const SKILL_FILENAME = 'openknowledge.skill';

export interface BuildAndOpenSkillOptions {
  /** Output path for the built skill file. Defaults to `~/Downloads/openknowledge.skill`. */
  out?: string;
  /** Build only — skip the OS file-association invocation. */
  noOpen?: boolean;
  /** Bypass the per-target `claude-cowork` install-state gate. Used by the
   * "Reinstall skill" affordance and by the CLI's `--force` flag. */
  force?: boolean;
  /** Test seam — defaults to `node:child_process.spawn`. */
  spawnFn?: SpawnLike;
  /** Test seam — defaults to `os.platform()`. */
  platformName?: NodeJS.Platform;
  /** Test seam — defaults to `os.homedir()`. */
  home?: string;
  /** Optional logger for skip / write events. Defaults to silent. */
  logger?: SkillInstallLogger;
}

export type BuildAndOpenSkillStatus =
  /** Build + file-association invocation both succeeded. */
  | 'installed'
  /** `noOpen`, unsupported platform, or handoff failed — file is on disk, no app launched. */
  | 'built'
  /** Build itself failed — no file written. */
  | 'failed'
  /**
   * Install-state gate hit: the `claude-cowork` entry in
   * `~/.ok/skill-state.yml` matched the current bundled skill version. No
   * rebuild, no handoff. The bundle from the prior install (if still on
   * disk) is unchanged.
   */
  | 'skip-current';

export interface BuildAndOpenSkillResult {
  status: BuildAndOpenSkillStatus;
  outputPath?: string;
  size?: number;
  sha256?: string;
  skillVersion?: string;
  /** Soft-fail signal when status is `'built'` and the OS handoff didn't run. */
  handoffError?: { reason: 'unsupported-platform' | 'spawn-error'; message: string };
  /** Hard-fail signal when status is `'failed'`. */
  buildError?: string;
  /** Set when status is `'skip-current'` — the file's recorded mtime. */
  recordedAt?: string;
}

function defaultDownloadsPath(home: string): string {
  return join(home, DOWNLOADS_DIR, SKILL_FILENAME);
}

/**
 * Invoke the OS file association for `.skill`. macOS: `open`. Windows:
 * `start` via cmd.exe. Linux: `xdg-open`. Detached + unref so the parent
 * exits cleanly while Claude Desktop launches in the background.
 *
 * Returns `{ ok: true }` on spawn success — NOT on install completion. We
 * have no observability across the OS boundary into Claude Desktop's native
 * install dialog.
 */
function invokeFileAssociation(
  skillPath: string,
  platformName: NodeJS.Platform,
  spawnFn: SpawnLike,
): { ok: true } | { ok: false; reason: 'unsupported-platform' | 'spawn-error'; message: string } {
  const detached: SpawnOptions = withHiddenWindowsConsole({
    detached: true,
    stdio: 'ignore',
  });
  try {
    if (platformName === 'darwin') {
      spawnFn('open', [skillPath], detached).unref();
      return { ok: true };
    }
    if (platformName === 'win32') {
      // cmd /c start "" "<path>" — empty quoted string is the window title
      // arg `start` requires when the path itself is quoted.
      spawnFn('cmd', ['/c', 'start', '""', skillPath], detached).unref();
      return { ok: true };
    }
    if (platformName === 'linux') {
      spawnFn('xdg-open', [skillPath], detached).unref();
      return { ok: true };
    }
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: `Platform '${platformName}' has no file-association invocation wired.`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn-error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function buildAndOpenSkill(
  opts: BuildAndOpenSkillOptions = {},
): Promise<BuildAndOpenSkillResult> {
  const home = opts.home ?? homedir();
  const outputPath = resolvePath(opts.out ?? defaultDownloadsPath(home));
  const platformName = opts.platformName ?? osPlatform();
  const spawnFn = opts.spawnFn ?? spawn;
  const logger = opts.logger;

  const report = async (
    outcome: SkillInstallEventOutcome,
    version?: string,
    reason?: string,
  ): Promise<void> => {
    await recordSkillInstallEvent(
      {
        ts: new Date().toISOString(),
        surface: 'server-build-and-open',
        target: 'claude-cowork',
        bundle: 'project',
        outcome,
        ...(version !== undefined ? { version } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
      { homedir: () => home, warn: logger?.warn },
    );
  };

  // Install-state gate: skip the rebuild when the on-disk file matches the
  // current skill version AND `force` is not set. Read errors fall through
  // to a fresh build (fail-soft).
  if (!opts.force) {
    let currentVersion: string | null = null;
    try {
      currentVersion = await readServerPackageVersion();
    } catch (err) {
      logger?.warn?.(
        { event: 'skill-install.gate.version-read-failed', error: String(err) },
        'Could not read @inkeep/open-knowledge-server version for gate check; rebuilding.',
      );
    }

    if (currentVersion !== null) {
      let recordedVersion: string | null = null;
      let recordedAt: string | null = null;
      try {
        [recordedVersion, recordedAt] = await Promise.all([
          readTargetVersion(home, 'claude-cowork', logger),
          readTargetRecordedAt(home, 'claude-cowork', logger),
        ]);
      } catch (err) {
        logger?.warn?.(
          { event: 'skill-install.gate.read-failed', error: String(err) },
          'Could not read claude-cowork install-state; rebuilding.',
        );
      }

      if (recordedVersion !== null && recordedVersion === currentVersion) {
        logger?.info?.(
          {
            event: 'skill-install.skip-current',
            target: 'claude-cowork',
            version: currentVersion,
          },
          'OpenKnowledge skill already delivered at current version; skipping rebuild.',
        );
        await report('skip-current', currentVersion);
        return {
          status: 'skip-current',
          skillVersion: currentVersion,
          ...(recordedAt !== null ? { recordedAt } : {}),
        };
      }
    }
  }

  // Ensure parent dir exists (e.g. ~/Downloads may be absent in test homes).
  try {
    await tracedMkdir(dirname(outputPath), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report('failed', undefined, `mkdir-failed:${message}`);
    return {
      status: 'failed',
      buildError: `could not create output directory: ${message}`,
    };
  }

  let build: BuildSkillZipResult;
  try {
    // Track 2 (.skill for Claude Chat / Cowork) ships the rich bundle only —
    // the slim discovery bundle has no value in Cowork.
    build = await buildSkillZip({ outputPath, bundle: 'project' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report('failed', undefined, `build-failed:${message}`);
    return {
      status: 'failed',
      buildError: message,
    };
  }

  const baseResult: BuildAndOpenSkillResult = {
    status: 'built',
    outputPath: build.outputPath,
    size: build.size,
    sha256: build.sha256,
    skillVersion: build.skillVersion,
  };

  // Write the per-target install-state on every successful build, even when
  // the OS handoff is skipped (`noOpen`) or fails. The bundle is on disk;
  // a future click should skip the rebuild even if Claude Desktop didn't
  // launch. Write failures fall through (fail-soft) — gate works for this
  // session via the stale-version path; next session re-records.
  if (build.skillVersion) {
    try {
      await writeTargetVersion(
        home,
        'claude-cowork',
        build.skillVersion,
        'server-build-and-open',
        logger,
      );
    } catch (err) {
      logger?.warn?.(
        {
          event: 'skill-install.state-write-failed',
          target: 'claude-cowork',
          version: build.skillVersion,
          error: String(err),
        },
        'Skill bundle built but install-state write failed; gate will re-trigger build on next click.',
      );
    }
  }

  if (opts.noOpen) {
    await report('built', build.skillVersion);
    return baseResult;
  }

  const invocation = invokeFileAssociation(build.outputPath, platformName, spawnFn);
  if (!invocation.ok) {
    await report('built', build.skillVersion, `handoff-${invocation.reason}`);
    return {
      ...baseResult,
      handoffError: { reason: invocation.reason, message: invocation.message },
    };
  }

  await report('installed', build.skillVersion);
  return { ...baseResult, status: 'installed' };
}
