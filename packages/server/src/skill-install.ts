import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  type EditorId,
  OPENKNOWLEDGE_SKILLS_REPO,
  USER_SKILL_HOSTS,
} from '@inkeep/open-knowledge-core';
import {
  type BuildSkillZipResult,
  buildSkillZip,
  resolveBundledSkillDir,
} from './build-skill-zip.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { tracedCpSync, tracedMkdir, tracedMkdirSync, tracedRmSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { BUNDLE_SKILL_NAME, type BundleId } from './skill-bundles.ts';
import { recordSkillInstallEvent, type SkillInstallEventOutcome } from './skill-install-events.ts';
import { resolveSkillInstallReportSettings } from './skill-install-report-config.ts';
import {
  readBundleDecision,
  readServerPackageVersion,
  readTargetRecordedAt,
  readTargetVersion,
  type SkillStateLogger,
  type SkillStateSurface,
  writeTargetVersion,
} from './skill-state.ts';
import { reportSkillInstall } from './skills-sh-install-report.ts';

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
   * `${home}/.ok/skill-state.yml` under target key `cli-hosts`; the skill
   * copies land under the agent-host roots that already exist, including
   * `${home}/.agents/skills/` when `.agents` is present. Tests pass a tmpdir
   * here.
   */
  home?: string;
  /** Optional logger. Falls back to `console.warn` / `console.info`. */
  logger?: SkillInstallLogger;
  /**
   * Install-source attribution recorded on the per-target YAML entry.
   * Defaults to `'cli-npx-skills-add'` for the CLI / `ok init` path — today's
   * only production caller. `'desktop-direct'` is the sibling value the
   * desktop's own writer (`skill-reclaim.ts`) records; it no longer reaches
   * this function.
   */
  surface?: SkillStateSurface;
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

export type InstallUserSkillResult = 'installed' | 'skip-current' | 'failed' | 'no-hosts';

/**
 * Pre-split user-global skill name. The legacy migration removes any install
 * under this name before the new `discovery` bundle lands. Sibling constant:
 * `LEGACY_SKILL_DIR_NAME` in `packages/desktop/src/main/skill-reclaim.ts`
 * (kept separate so the desktop module stays free of server imports).
 */
const LEGACY_USER_SKILL_NAME = 'open-knowledge';

/**
 * Vendor-neutral central store. `.agents` follows the same consent boundary as
 * every other host root: it is written only when that root already exists.
 */
const CENTRAL_HOST_DIR = '.agents';

function centralSkillDir(home: string, bundleName: string): string {
  return join(home, CENTRAL_HOST_DIR, 'skills', bundleName);
}

/** A user-global skill destination: the central store, or one detected host. */
export interface DetectedSkillHost {
  /** Home-relative dotdir whose presence means the host is installed. */
  readonly hostDir: string;
  /** Home-relative directory that contains this host's skill bundles. */
  readonly skillsRoot: string;
  readonly editorId: EditorId;
}

/**
 * The OK-supported agent hosts actually present under `home`.
 *
 * STOP: this detection gate is load-bearing. OK writes agent INSTRUCTIONS, not
 * inert config — a skill dir created for a tool the user never installed is
 * both clutter and a scope-of-consent violation (issue #820, where a single
 * `ok init` created 51 tool-config dirs in a real `$HOME`). Every user-global
 * write site MUST filter through this. Host set comes from core's
 * `USER_SKILL_HOSTS`, derived from `EDITOR_USER_SKILL_ROOT`, so it preserves
 * nested user layouts such as Pi's `.pi/agent/skills`.
 */
export function detectUserSkillHosts(home: string): DetectedSkillHost[] {
  return USER_SKILL_HOSTS.filter((host) => existsSync(join(home, host.hostDir)));
}

async function installedUserSkillExists(home: string, bundleName: string): Promise<boolean> {
  const candidates = detectUserSkillHosts(home).map((host) =>
    join(home, host.skillsRoot, bundleName),
  );
  if (existsSync(join(home, CENTRAL_HOST_DIR))) {
    candidates.push(centralSkillDir(home, bundleName));
  }

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return true;
    } catch {
      // A missing or unreadable destination cannot satisfy the disk-presence gate.
    }
  }
  return false;
}

/**
 * Legacy migration: remove any pre-split user-global `open-knowledge` skill dir
 * before the `discovery` bundle lands. Swept across the detected hosts plus the
 * central store (Codex's former home before it moved to `.codex`). Fail-soft —
 * a removal failure is logged and swallowed; the install below is what the
 * result gates on. Sibling: `removeLegacyUserSkillDirs` in the desktop reclaim.
 */
function removeLegacyUserSkillDirs(
  home: string,
  hosts: readonly DetectedSkillHost[],
  logger: SkillInstallLogger,
): void {
  const legacySkillRoots = [...hosts.map((host) => host.skillsRoot), `${CENTRAL_HOST_DIR}/skills`];
  for (const skillsRoot of legacySkillRoots) {
    const legacyDir = join(home, skillsRoot, LEGACY_USER_SKILL_NAME);
    if (!existsSync(legacyDir)) continue;
    try {
      tracedRmSync(legacyDir, { recursive: true, force: true });
      logger.info?.(
        { event: 'skill-install.legacy-removed', path: legacyDir },
        'Removed pre-split `open-knowledge` user-global skill dir.',
      );
    } catch (err) {
      logger.warn(
        { event: 'skill-install.legacy-remove-failed', path: legacyDir, err },
        'Legacy `open-knowledge` skill removal failed; continuing with install.',
      );
    }
  }
}

/**
 * Replace `destDir` with a fresh copy of `sourceDir`. `rm -rf` first so a
 * shrinking bundle can't leave orphaned files from a prior version behind.
 */
function replaceSkillDir(sourceDir: string, destDir: string): void {
  tracedRmSync(destDir, { recursive: true, force: true });
  tracedMkdirSync(dirname(destDir), { recursive: true });
  tracedCpSync(sourceDir, destDir, { recursive: true });
}

/** Per-destination outcome, for the structured install log. */
interface SkillWriteEntry {
  path: string;
  status: 'written' | 'failed';
  error?: string;
}

/**
 * Copy one bundle into every usable destination. Callers pass an
 * already-filtered host set and whether the ordinary `.agents` host exists, so
 * this never turns its own writes into future host-detection evidence.
 */
function writeBundleToHosts(
  home: string,
  bundleName: string,
  sourceDir: string,
  hosts: readonly DetectedSkillHost[],
  includeCentral: boolean,
): SkillWriteEntry[] {
  const entries: SkillWriteEntry[] = [];
  const centralDest = centralSkillDir(home, bundleName);
  const destinations = [
    ...(includeCentral ? [centralDest] : []),
    ...hosts
      .map((host) => join(home, host.skillsRoot, bundleName))
      // Defensive: a host dest that collapses onto the central store would be a
      // redundant double-write of the same bytes. No host root is `.agents`
      // today, but the guard keeps the central write authoritative if that
      // ever changes.
      .filter((dest) => dest !== centralDest),
  ];

  for (const dest of destinations) {
    try {
      replaceSkillDir(sourceDir, dest);
      entries.push({ path: dest, status: 'written' });
    } catch (err) {
      entries.push({
        path: dest,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return entries;
}

/**
 * Install one user-global OpenKnowledge Agent Skill bundle into the agent hosts
 * actually present under `home`.
 *
 * Writes directly — no subprocess, no network. This used to shell out to
 * `npx skills@~1.5.0 add … --agent '*' -g -y --copy`; `--agent '*'` bypassed
 * that CLI's host detection and created a skill dir in all ~75 hosts it knows,
 * so one `ok init` wrote 51 tool-config dirs for tools the user had never
 * installed (issue #820). Nothing about that dependency was load-bearing: OK
 * passes a local path (no source resolution), forces `--copy` (no symlinks),
 * and the CLI writes no lockfile or state at global scope — it contributed a
 * directory table, which OK already maintains in core for project scope. It
 * also cost a floating-range `npx -y` fetch-and-execute at init time and
 * third-party telemetry OK never opted out of.
 *
 * Destinations: `${home}/.<host>/skills/<name>/` for each detected host,
 * including the central `${home}/.agents/skills/<name>/` store only when its
 * root already exists — and NOTHING when no host is detected (`'no-hosts'`),
 * so a machine with no agent tooling gets no dirs at all. See
 * `detectUserSkillHosts` for why that gate is load-bearing.
 *
 * Idempotency: the `cli-hosts` entry in `${home}/.ok/skill-state.yml` gates
 * re-install. Nothing is written (and `'skip-current'` is returned) only when
 * BOTH the recorded version matches the current
 * `@inkeep/open-knowledge-server` package version AND the skill directory is
 * still present under at least one currently installed host root. The
 * disk-presence check exists because a manual `rm` of the skill leaves the
 * state file untouched, which would otherwise wedge the next `ok init` into a
 * no-op despite the skill being gone.
 *
 * Always resolves (never throws). Returns `'failed'` when no usable install
 * could be RECORDED — every destination write errored, a pre-write dependency
 * was missing (version read, bundled asset), or the state-file write failed
 * after the copies landed. That last case is why `'failed'` does not imply
 * "nothing on disk": the skill dirs exist but the version gate never advanced,
 * so the next run reinstalls rather than skipping. A partial host failure is
 * the opposite — it records the version and returns `'installed'`, because the
 * surviving copies are usable.
 */
export async function installUserSkill(
  opts: InstallUserSkillOptions = {},
): Promise<InstallUserSkillResult> {
  const home = opts.home ?? homedir();
  const logger: SkillInstallLogger = opts.logger ?? {
    warn: (data, message) => getLogger('skills').warn(data, message),
    info: (data, message) => getLogger('skills').info(data, message),
  };
  // Historical enum value — kept verbatim because it is persisted in every
  // existing `~/.ok/skill-state.yml` and `skill-install-events.jsonl`; the
  // install no longer shells out to npx.
  const surfaceAttribution: SkillStateSurface = opts.surface ?? 'cli-npx-skills-add';
  const bundleId = opts.bundleId ?? 'discovery';
  const bundleName = BUNDLE_SKILL_NAME[bundleId];

  // FIRST, before anything derives a path from `home` — including `report`,
  // which appends the JSONL event log at `<home>/.ok/`. `join('', '.claude', …)`
  // is RELATIVE and `os.homedir()` returns `$HOME` verbatim, so a broken or
  // unset HOME sends every path below (the recursive `rmSync` in
  // `replaceSkillDir`, and the event log itself) into the process cwd — for the
  // CLI, the user's project. Nothing is recorded on this path: there is nowhere
  // safe to record it. Returns rather than throws: never-throws contract.
  if (!isAbsolute(home)) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'home-not-absolute', home },
      'Skill install aborted — $HOME is not an absolute path.',
    );
    return 'failed';
  }

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

  // Opt-out backstop, enforced HERE rather than trusted to every caller. The
  // decline gate lived only in the callers, so a new one that forgot it would
  // reinstall a bundle the user had explicitly turned off — and because a
  // decline also REMOVES the bundle from disk, that reinstall reverses a
  // deliberate choice rather than merely being redundant.
  //
  // Keys on an explicit `false`, NOT on `resolveBundleEnabled`. That helper's
  // `decision ?? installedOnDisk` fallback belongs to the reclaim sweeps, which
  // run unprompted on every launch and must not resurrect a bundle on a machine
  // that never consented. This function is only ever reached deliberately, and
  // `ok init` records the decision BEFORE calling — so an absent decision here
  // means "first install", not "declined", and must still install.
  let declined: boolean | null;
  try {
    declined = await readBundleDecision(home, bundleName, logger);
  } catch (err) {
    // Read FAILURE is not "no decision". Collapsing the two (EACCES after a
    // `sudo ok init`, a truncated write, a corrupted YAML) would install a
    // bundle whose recorded state might be an explicit decline — and a decline
    // also removes the files, so reversing it is visible and unwanted. When the
    // answer is unknowable, decline: an over-cautious skip is recoverable and
    // reported in the init summary, whereas silently undoing an opt-out is not.
    logger.warn(
      { event: 'skill-install.gate.decision-read-failed', bundle: bundleId, err },
      'Could not read the opt-out decision; skipping the install rather than risk reversing it.',
    );
    await report('skip-current', undefined, 'decision-read-failed');
    return 'skip-current';
  }
  if (declined === false) {
    logger.info?.(
      { event: 'skill-install.declined', bundle: bundleId },
      'Bundle is opted out; skipping user-global skill install.',
    );
    await report('skip-current', undefined, 'declined');
    return 'skip-current';
  }

  let currentVersion: string;
  try {
    currentVersion = await readServerPackageVersion();
  } catch (err) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'version-read-failed', err },
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
      { event: 'skill-install.gate.read-failed', err },
      'Could not read cli-hosts install-state; proceeding with fresh install.',
    );
    return null;
  });
  if (!opts.force && existingVersion !== null && existingVersion === currentVersion) {
    if (await installedUserSkillExists(home, bundleName)) {
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
        err,
      },
      'Skill install aborted — bundled SKILL.md asset not found.',
    );
    await report('failed', currentVersion, 'bundled-asset-missing');
    return 'failed';
  }
  // Detect BEFORE writing anything. `.agents` is an ordinary host: it receives
  // a copy only when its root already exists, and does not authorize creating
  // itself merely because another editor is installed.
  const hosts = detectUserSkillHosts(home);
  const includeCentral = existsSync(join(home, CENTRAL_HOST_DIR));
  if (hosts.length === 0 && !includeCentral) {
    logger.info?.(
      { event: 'skill-install.no-hosts', version: currentVersion },
      'No supported agent host detected; skipping user-global skill install.',
    );
    await report('skip-current', currentVersion, 'no-hosts');
    return 'no-hosts';
  }

  // Drop any pre-split `open-knowledge` user-global install first (no-op on a
  // fresh machine). Fail-soft — the writes below are what the result gates on.
  removeLegacyUserSkillDirs(home, hosts, logger);

  const entries = writeBundleToHosts(home, bundleName, bundleDir, hosts, includeCentral);
  const written = entries.filter((e) => e.status === 'written');
  const failed = entries.filter((e) => e.status === 'failed');

  if (written.length === 0) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'write-failed', entries: failed },
      'Skill install failed — every destination write errored.',
    );
    await report('failed', currentVersion, 'write-failed');
    return 'failed';
  }

  try {
    await writeTargetVersion(home, 'cli-hosts', currentVersion, surfaceAttribution, logger);
  } catch (err) {
    logger.warn(
      { event: 'skill-install.failed', reason: 'sidecar-write-failed', err },
      'Skill install succeeded but sidecar write failed.',
    );
    await report('failed', currentVersion, 'sidecar-write-failed');
    return 'failed';
  }

  if (failed.length > 0) {
    logger.warn(
      { event: 'skill-install.partial', version: currentVersion, entries: failed },
      'Some agent hosts could not be written; the remaining copies are installed.',
    );
  }
  logger.info?.(
    {
      event: 'skill-install.installed',
      version: currentVersion,
      hosts: hosts.map((h) => h.editorId),
      paths: written.map((e) => e.path),
    },
    `OpenKnowledge skill installed to ${written.length} location(s): ${written
      .map((e) => e.path)
      .join(', ')}`,
  );
  await report('installed', currentVersion);
  // Count this install on skills.sh. Built-ins ship inside the app bundle, so
  // there is nothing to fetch from the marketplace and the event is the only
  // way the listing can reflect them. Deduped per machine inside the reporter,
  // so the launch reclaim and a re-run of `ok init` contribute nothing.
  //
  // NOT awaited. `ok init` loops this once per user-global bundle, so awaiting
  // a third-party HTTP call with a 3s timeout would add seconds of dead wait to
  // every init on a firewalled or offline machine. The reporter claims its
  // ledger entry before sending, so dropping the request costs one uncounted
  // install rather than a duplicate.
  void reportSkillInstall(
    {
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skills: [bundleName],
      agents: hosts.map((h) => h.editorId),
      global: true,
      version: currentVersion,
    },
    { home, enabled: resolveSkillInstallReportSettings(home).enabled },
  );
  return 'installed';
}

// ─── Claude Desktop install (.skill file + OS file association) ────────────
//
// Distinct surface from `installUserSkill` above (which copies the bundle
// into Claude Code / Cursor / Codex skill dirs). This path produces an
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
        { event: 'skill-install.gate.version-read-failed', err },
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
          { event: 'skill-install.gate.read-failed', err },
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

  // The Cowork install-state gate keys on the server PACKAGE version (the
  // single version axis), NOT a SKILL.md metadata field — the bundled SKILL.md
  // carries no version stamp. Record the same value the gate above reads back.
  let installedVersion: string | undefined;
  try {
    installedVersion = await readServerPackageVersion();
  } catch {
    installedVersion = undefined;
  }

  const baseResult: BuildAndOpenSkillResult = {
    status: 'built',
    outputPath: build.outputPath,
    size: build.size,
    sha256: build.sha256,
    skillVersion: installedVersion,
  };

  // Write the per-target install-state on every successful build, even when
  // the OS handoff is skipped (`noOpen`) or fails. The bundle is on disk;
  // a future click should skip the rebuild even if Claude Desktop didn't
  // launch. Write failures fall through (fail-soft) — gate works for this
  // session via the stale-version path; next session re-records.
  if (installedVersion) {
    try {
      await writeTargetVersion(
        home,
        'claude-cowork',
        installedVersion,
        'server-build-and-open',
        logger,
      );
    } catch (err) {
      logger?.warn?.(
        {
          event: 'skill-install.state-write-failed',
          target: 'claude-cowork',
          version: installedVersion,
          err,
        },
        'Skill bundle built but install-state write failed; gate will re-trigger build on next click.',
      );
    }
  }

  if (opts.noOpen) {
    await report('built', installedVersion);
    return baseResult;
  }

  const invocation = invokeFileAssociation(build.outputPath, platformName, spawnFn);
  if (!invocation.ok) {
    await report('built', installedVersion, `handoff-${invocation.reason}`);
    return {
      ...baseResult,
      handoffError: { reason: invocation.reason, message: invocation.message },
    };
  }

  await report('installed', installedVersion);
  // Count the Claude Desktop / Cowork funnel. Reported at `installed` only —
  // the point where the file-association handoff actually succeeded — not on
  // `built`, where the file is merely sitting in Downloads. The final step
  // happens inside Claude Desktop's own installer, so this is the strongest
  // signal we can observe; the per-machine ledger keeps a repeat click from
  // counting twice. Machine-scoped: this bundle is installed once per machine.
  void reportSkillInstall(
    {
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skills: [BUNDLE_SKILL_NAME.project],
      agents: ['claude-desktop'],
      global: true,
      version: installedVersion,
    },
    { home, enabled: resolveSkillInstallReportSettings(home).enabled },
  );
  return { ...baseResult, status: 'installed' };
}
