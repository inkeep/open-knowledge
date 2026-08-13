/**
 * CLI parity for the Desktop's skill-reclaim sweeps, both SEED-IF-ABSENT:
 *   - `reclaimProjectSkillsOnProjectOpen` (leave an existing SKILL.md untouched;
 *     create one for an OK-wired editor that has none — here always create-
 *     enabled because the sweep only ever runs inside a confirmed `.ok/` project)
 *   - `reclaimUserSkillsOnLaunch` (seed the user-global central + per-host dirs
 *     only when absent)
 *
 * Why this exists: a teammate using only `@inkeep/open-knowledge` (no Desktop
 * install) needs the built-in skills present without a Desktop launch. The
 * built-ins are seeded when missing and then left alone — a present copy may be
 * a user-applied skills.sh update, so updates flow through the manual "update
 * available" path, never a force-refresh. Wired
 * into `bootStartServer` and exposed as `ok repair-skills` for explicit
 * invocation. Reference: packages/desktop/src/main/skill-reclaim.ts.
 *
 * The user-scope sweep records `~/.ok/skill-state.yml`'s `cli-hosts` entry on a
 * clean reconcile and skips early when the recorded version equals the bundled
 * version AND every enabled built-in is on disk. The project-scope sweep is NOT
 * version-gated (a deleted project skill must re-seed regardless).
 */
import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import {
  BUNDLE_SKILL_NAME,
  type BundleId,
  readBundleDecision,
  readServerPackageVersion,
  readTargetVersion,
  recordSkillInstallEvent,
  resolveBundledSkillDir,
  resolveBundleEnabled,
  type SkillInstallEvent,
  USER_GLOBAL_BUNDLE_IDS,
  writeBundleDecision,
  writeTargetVersion,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import {
  applyLegacyFanoutSweep,
  type LegacyFanoutSweepPlan,
  planLegacyFanoutSweep,
  removeUserGlobalSkillBundle,
} from '../integrations/skill-teardown.ts';
import { assertProjectPathSafe } from '../integrations/write-project-skill.ts';
import { accent, dim, warning } from '../ui/colors.ts';
import { EDITOR_TARGETS, type EditorId, HOSTS_WITH_USER_SKILL_DIR } from './editors.ts';

// `HOSTS_WITH_USER_SKILL_DIR` is the canonical core constant (derived from
// PROJECT_SKILL_EDITOR_IDS + EDITOR_PROJECT_SKILL_ROOT), shared with the desktop
// `skill-reclaim` sweep — no longer a per-module literal that can drift.

/** Slim discovery bundle — user-global central + per-host installs. */
const USER_SKILL_DIR_NAME = 'open-knowledge-discovery';
/** Rich project bundle — project-local installs (keeps `name: open-knowledge`). */
const PROJECT_SKILL_DIR_NAME = 'open-knowledge';
const CENTRAL_USER_SKILL_REL = ['.agents', 'skills', USER_SKILL_DIR_NAME] as const;

export interface RepairSkillsLogEvent {
  event: string;
  scope?: 'project' | 'user';
  editorId?: string;
  hostDir?: string;
  path?: string;
  version?: string;
  preexisting?: boolean;
  reason?: string;
  /** Bundle id for per-bundle events. Matches the desktop reclaim's `bundle:` key. */
  bundle?: string;
  error?: string;
}

export interface RepairSkillsFsOps {
  existsSync(path: string): boolean;
  isDirectory(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, content: Buffer): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

const defaultFsOps: RepairSkillsFsOps = {
  existsSync: (path) => fsExistsSync(path),
  isDirectory: (path) => {
    try {
      return fsStatSync(path).isDirectory();
    } catch (err) {
      // ENOENT is the "path doesn't exist" case the file walker expects.
      // Propagate EACCES/EIO/etc. so the surrounding per-host catch logs the
      // real permission error rather than misclassifying as "not a dir" and
      // letting `readFileSync` later throw a misleading EISDIR.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },
  readdirSync: (path) => fsReaddirSync(path),
  readFileSync: (path) => fsReadFileSync(path),
  writeFileSync: (path, content) => {
    fsWriteFileSync(path, content);
  },
  mkdirSync: (path, options) => {
    fsMkdirSync(path, options);
  },
  rmSync: (path, options) => {
    fsRmSync(path, options);
  },
};

export interface RepairSkillsDeps {
  /** Override for `resolveBundledSkillDir('project')`. */
  resolveProjectBundledSkillDir?(): string;
  /** Override for `resolveBundledSkillDir(<user-global bundle>)`. */
  resolveUserBundledSkillDir?(bundle: BundleId): string;
  /** Override for the per-package version reader. */
  readBundledVersion?(): Promise<string>;
  /** Override for `readTargetVersion(home, 'cli-hosts')`. */
  readRecordedVersion?(home: string): Promise<string | null>;
  /** Override for `writeTargetVersion(home, 'cli-hosts', version, 'cli-start')`. */
  writeRecordedVersion?(home: string, version: string): Promise<void>;
  /**
   * Override for `recordSkillInstallEvent` — the JSONL telemetry append at
   * `~/.ok/skill-install-events.jsonl`. Mirrors Desktop's
   * `reclaimUserSkillsOnLaunch` outcome-recording contract so the aggregate
   * "did this install land?" question is answerable for CLI users too.
   */
  recordEvent?(event: SkillInstallEvent): Promise<void>;
  /** Override for `readBundleDecision(home, name)` — per-bundle opt-in gate. */
  readBundleDecision?(home: string, bundleName: string): Promise<boolean | null>;
  /** Override for `writeBundleDecision(home, name, enabled)` — grandfather materialization. */
  writeBundleDecision?(home: string, bundleName: string, enabled: boolean): Promise<void>;
  /** Override for `removeUserGlobalSkillBundle(home, id)` — decline removal. */
  removeBundleFromDisk?(home: string, bundleId: BundleId): void;
}

const defaultDeps: Required<RepairSkillsDeps> = {
  resolveProjectBundledSkillDir: () => resolveBundledSkillDir('project', { checkDesktop: false }),
  resolveUserBundledSkillDir: (bundle) => resolveBundledSkillDir(bundle, { checkDesktop: false }),
  readBundledVersion: () => readServerPackageVersion(),
  readRecordedVersion: (home) => readTargetVersion(home, 'cli-hosts'),
  writeRecordedVersion: (home, version) =>
    writeTargetVersion(home, 'cli-hosts', version, 'cli-start'),
  recordEvent: (event) => recordSkillInstallEvent(event),
  readBundleDecision: (home, name) => readBundleDecision(home, name),
  writeBundleDecision: (home, name, enabled) => writeBundleDecision(home, name, enabled),
  removeBundleFromDisk: (home, bundleId) => removeUserGlobalSkillBundle(home, bundleId),
};

export interface RepairSkillsContext {
  /** Absolute path to the project root. */
  projectDir: string;
  /** Value of `process.env.OK_RECLAIM_DISABLE` — '1' disables all sweeps. */
  reclaimDisableEnv?: string | null;
  /** Override `os.homedir()` for tests. */
  home?: string;
  /** Sink for structured per-step events. Default: stderr JSON-lines. */
  logger?: (event: RepairSkillsLogEvent) => void;
  /** DI overrides for bundled-asset + state IO. Tests inject mocks. */
  deps?: RepairSkillsDeps;
  /** Override fs primitives for tests. */
  fs?: RepairSkillsFsOps;
  /**
   * Decide whether to delete the directories a pre-0.42 fan-out left behind
   * (issue #820). Called ONLY when there is something to remove, with the exact
   * plan. Returning false leaves every path in place.
   *
   * Required to delete anything: with no confirmer the sweep is skipped, so a
   * caller that never wired consent can't quietly remove files from `$HOME`.
   * `repairSkillsCommand` supplies an interactive prompt (or an auto-yes under
   * `--yes`); tests inject a stub.
   */
  confirmLegacyCleanup?: (plan: LegacyFanoutSweepPlan) => Promise<boolean>;
}

export type ProjectSkillOutcome = 'no-token' | 'present' | 'created' | 'failed';
export type UserSkillCentralOutcome = 'written' | 'skipped-present' | 'failed';
export type UserSkillHostOutcome =
  | 'written'
  | 'skipped-present'
  | 'skipped-host-absent'
  | 'skipped-collapsed-with-central'
  | 'failed';

export interface ProjectSkillEntry {
  editorId: string;
  hostDir: string;
  path: string;
  outcome: ProjectSkillOutcome;
  error?: string;
}

export type UserSkillEntry =
  | {
      kind: 'central';
      path: string;
      outcome: UserSkillCentralOutcome;
      error?: string;
    }
  | {
      kind: 'host';
      editorId: string;
      hostDir: string;
      path: string;
      outcome: UserSkillHostOutcome;
      error?: string;
    };

export type ProjectSweepResult =
  | { outcome: 'done'; entries: ProjectSkillEntry[] }
  | { outcome: 'skipped'; reason: string };

export type UserSweepResult =
  | { outcome: 'done'; version: string; entries: UserSkillEntry[] }
  | { outcome: 'skipped'; reason: string };

export type RepairSkillsResult =
  | { status: 'skipped'; reason: string }
  | {
      status: 'done';
      project: ProjectSweepResult;
      user: UserSweepResult;
      /**
       * Paths removed from hosts a pre-0.42 fan-out reached but OK never
       * supported (issue #820) — OK's skill dirs plus any agent home left empty
       * by their removal. Empty on a machine that never ran an affected
       * version, on every run after the first, and whenever the user declines.
       */
      legacySwept: string[];
      /** True when a cleanup was available and the user (or `--yes`) declined it. */
      legacyCleanupDeclined: boolean;
      /**
       * True when the user APPROVED the cleanup but it refused to run — a
       * re-validation failure, i.e. a bug. Kept separate from
       * `legacyCleanupDeclined` so the summary never reports our failure as
       * the user's choice.
       */
      legacyCleanupFailed: boolean;
    };

function defaultLogger(event: RepairSkillsLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/**
 * Replace `destDir` with a recursive copy of `sourceDir`. Sibling of
 * `replaceDir` in `packages/desktop/src/main/skill-reclaim.ts`.
 *
 * The CLI doesn't run inside Electron so Node's `cpSync` would work here.
 * We keep the walk-based form to match the desktop's behavior byte-for-byte
 * and to let tests inject a memory-backed `fs` without depending on Node's
 * native recursion.
 *
 * `rmSync` is load-bearing — a manual walk that only overwrote existing
 * files would leave orphans on disk when a SKILL bump drops a file.
 */
function replaceDir(sourceDir: string, destDir: string, fs: RepairSkillsFsOps): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(dirname(destDir), { recursive: true });
  copyDirContents(sourceDir, destDir, fs);
}

function copyDirContents(sourceDir: string, destDir: string, fs: RepairSkillsFsOps): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir)) {
    const src = join(sourceDir, entry);
    const dst = join(destDir, entry);
    if (fs.isDirectory(src)) {
      copyDirContents(src, dst, fs);
    } else {
      fs.writeFileSync(dst, fs.readFileSync(src));
    }
  }
}

function userBundleExists(home: string, bundleName: string, fs: RepairSkillsFsOps): boolean {
  return (
    fs.existsSync(join(home, '.agents', 'skills', bundleName)) ||
    USER_SKILL_HOSTS.some((host) => fs.existsSync(join(home, host.skillsRoot, bundleName)))
  );
}

/**
 * Install ONE user-global bundle into each existing user-skill host root,
 * under its own `bundleDirName`. Returns the per-write entries, whether any
 * write landed (a fresh seed, for the outcome telemetry), and whether the
 * bundle reached any destination at all. Looped over `USER_GLOBAL_BUNDLE_IDS`
 * by `runUserSweep` so each user-global built-in (discovery + write-skill) is
 * seeded when absent.
 *
 * Both flags are PER BUNDLE by construction: the version-advance gate and the
 * outcome event must not read them off a pooled entry list, or one bundle's
 * success answers for a sibling that landed nowhere.
 */
function installUserBundleToHostDirs(
  home: string,
  bundleDirName: string,
  sourceDir: string,
  fs: RepairSkillsFsOps,
  logger: (event: RepairSkillsLogEvent) => void,
  version: string,
): { entries: UserSkillEntry[]; anyWritten: boolean; anyDestinationSucceeded: boolean } {
  const entries: UserSkillEntry[] = [];
  const centralDest = join(home, '.agents', 'skills', bundleDirName);
  // SEED-IF-ABSENT: guarantee the built-in is PRESENT
  // but never OVERWRITE an existing copy — that copy may be a user-applied
  // skills.sh update. Updates flow through the manual "update available" path,
  // not this sweep. Matches the desktop reclaim's gate exactly.
  const centralRootExists = fs.existsSync(join(home, '.agents'));
  if (centralRootExists && fs.existsSync(centralDest)) {
    entries.push({ kind: 'central', path: centralDest, outcome: 'skipped-present' });
  } else if (centralRootExists) {
    try {
      replaceDir(sourceDir, centralDest, fs);
      entries.push({ kind: 'central', path: centralDest, outcome: 'written' });
      logger({
        event: 'user-skill-reclaim-central-written',
        scope: 'user',
        path: centralDest,
        preexisting: false,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({ kind: 'central', path: centralDest, outcome: 'failed', error });
      logger({
        event: 'user-skill-reclaim-central-failed',
        scope: 'user',
        path: centralDest,
        error,
      });
    }
  }

  for (const host of USER_SKILL_HOSTS) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(home, host.skillsRoot, bundleDirName);
    if (hostDest === centralDest) {
      // Defensive: a per-host dest that resolves to the central store's own
      // path would be a redundant double-write. No host root currently
      // coincides with `.agents`, but keep the guard if that ever changes.
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'skipped-collapsed-with-central',
      });
      continue;
    }
    if (!fs.existsSync(hostRoot)) {
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'skipped-host-absent',
      });
      continue;
    }
    // Seed-if-absent per host too: an existing host copy is left as-is.
    if (fs.existsSync(hostDest)) {
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'skipped-present',
      });
      continue;
    }
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'written',
      });
      logger({
        event: 'user-skill-reclaim-host-written',
        scope: 'user',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        preexisting: false,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: 'failed',
        error,
      });
      logger({
        event: 'user-skill-reclaim-host-failed',
        scope: 'user',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        error,
      });
    }
  }
  return {
    entries,
    anyWritten: entries.some((entry) => entry.outcome === 'written'),
    anyDestinationSucceeded: entries.some(
      (entry) => entry.outcome === 'written' || entry.outcome === 'skipped-present',
    ),
  };
}

/**
 * True iff `configPath` exists and its bytes contain the version-independent
 * chain-sentinel family prefix (`# ok-mcp-`) — proof the editor is wired for
 * this OK project. The sentinel is the first line of every managed MCP
 * entry's resilient-chain body and is substring-present in both the JSON and
 * TOML on-disk forms, so a plain `includes` check is format-agnostic. The
 * prefix covers both platforms' sentinels and every version: "wired at all"
 * must survive a sentinel bump (a project wired under `# ok-mcp-v1` is still
 * wired after the chain moves to `v2` — the entry upgrades lazily via the
 * repair sweep). Same shape as `OK_MCP_MARKER_PREFIX` in the desktop's
 * `worktree-setup-inherit.ts`. A read error (torn / unreadable config)
 * classifies as "not wired" rather than throwing, so one bad config never
 * blocks the other hosts.
 */
const OK_MCP_MARKER_PREFIX = '# ok-mcp-';

function editorWiredForOk(configPath: string | undefined, fs: RepairSkillsFsOps): boolean {
  if (!configPath) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    const bytes = fs.readFileSync(configPath).toString('utf8');
    return bytes.includes(OK_MCP_MARKER_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Project-scope sweep. Per-host gate: refresh a host whose `SKILL.md` already
 * exists; additionally CREATE the skill for any host whose project MCP config
 * already carries the OK marker (`editorWiredForOk`). Always create-enabled:
 * the only callers are `ok start` (guarded to run inside an `.ok/` project root)
 * and the explicit `ok repair-skills` subcommand, so "this is an OK project" is
 * already established — there is no fresh/non-OK open to guard against here (the
 * Desktop, which DOES see non-OK opens, gates with its own `createIfWired`
 * flag). Heals the cohort of OK projects wired for MCP before the project-skill
 * writer existed.
 */
function runProjectSweep(
  projectDir: string,
  deps: Required<RepairSkillsDeps>,
  fs: RepairSkillsFsOps,
  logger: (event: RepairSkillsLogEvent) => void,
): ProjectSweepResult {
  let sourceDir: string;
  try {
    sourceDir = deps.resolveProjectBundledSkillDir();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'project-skill-reclaim-bundle-missing', scope: 'project', error });
    return { outcome: 'skipped', reason: 'bundle-missing' };
  }

  const entries: ProjectSkillEntry[] = [];
  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const dest = join(projectDir, host.hostDir, 'skills', PROJECT_SKILL_DIR_NAME);
    const skillFile = join(dest, 'SKILL.md');
    const skillExists = fs.existsSync(skillFile);
    // Seed-if-absent: an existing project skill is left untouched (a pulled/
    // shared project never silently changes; updates flow through skills.sh).
    if (skillExists) {
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'present',
      });
      continue;
    }
    // Create only when the editor is OK-wired for this project. The host's
    // `editorId` is a valid `EDITOR_TARGETS` key by the coverage meta-test, so
    // the lookup + `projectConfigPath` resolution reuse the single source of
    // truth (no duplicated per-editor path table).
    const projectConfigPath =
      EDITOR_TARGETS[host.editorId as EditorId]?.projectConfigPath?.(projectDir);
    const wired = editorWiredForOk(projectConfigPath, fs);
    if (!wired) {
      // Greenfield host that never ran `ok init` AND isn't OK-wired, or a host
      // wired for some OTHER editor's MCP but not this one — nothing to do.
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'no-token',
      });
      logger({
        event: 'project-skill-reclaim-no-token',
        scope: 'project',
        editorId: host.editorId,
        path: dest,
      });
      continue;
    }
    try {
      // Symlink-escape guard before `replaceDir`'s rmSync — without this, a
      // pre-existing `.claude -> /etc` (or similar) inside a malicious cloned
      // repo would route the recursive removal + copy through the symlink
      // target. Same defense `writeProjectSkill` (the `ok init` writer) has
      // run since project-scope writes were added. The gate above is only
      // partial defense — a planted SKILL.md symlink can satisfy `existsSync`,
      // and the create path authors a fresh dir, so the guard is mandatory.
      assertProjectPathSafe(dest, projectDir);
      replaceDir(sourceDir, dest, fs);
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'created',
      });
      logger({
        event: 'project-skill-reclaim-created',
        scope: 'project',
        editorId: host.editorId,
        path: dest,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome: 'failed',
        error,
      });
      logger({
        event: 'project-skill-reclaim-failed',
        scope: 'project',
        editorId: host.editorId,
        path: dest,
        error,
      });
    }
  }

  return { outcome: 'done', entries };
}

async function runUserSweep(
  home: string,
  deps: Required<RepairSkillsDeps>,
  fs: RepairSkillsFsOps,
  logger: (event: RepairSkillsLogEvent) => void,
): Promise<UserSweepResult> {
  const recordEventSoft = (event: SkillInstallEvent): void => {
    // Telemetry must never affect install outcomes — wrap in a swallowed catch
    // identical to Desktop's `.catch(() => {})` pattern.
    void deps.recordEvent(event).catch(() => {});
  };
  const nowIso = (): string => new Date().toISOString();

  // Read both versions before opening the bundle so the version-current
  // fast-path avoids touching disk.
  let bundledVersion: string;
  try {
    bundledVersion = await deps.readBundledVersion();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'user-skill-reclaim-version-read-failed', scope: 'user', error });
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      bundle: 'discovery',
      outcome: 'failed',
      reason: `version-read-failed:${error}`,
    });
    return { outcome: 'skipped', reason: 'version-read-failed' };
  }

  let recordedVersion: string | null;
  try {
    recordedVersion = await deps.readRecordedVersion(home);
  } catch (err) {
    // `readTargetVersion` returns null on ENOENT but propagates other fs
    // errors (EACCES, EIO) — see `readSkillStateFile` in
    // `packages/server/src/skill-state.ts`. Treat as absent so the sweep
    // proceeds and self-heals on the next launch, but emit a structured
    // event so a wrong-permissions `~/.ok/skill-state.yml` (e.g. after a
    // `sudo ok start`) is observable rather than silently bypassing the
    // version-current fast path on every boot.
    logger({
      event: 'user-skill-reclaim-version-read-error',
      scope: 'user',
      error: err instanceof Error ? err.message : String(err),
    });
    recordedVersion = null;
  }

  // Resolve every user-global built-in bundle's source up front (discovery +
  // write-skill, from the single-source `USER_GLOBAL_BUNDLE_IDS`). The bundles
  // ship together, so a resolve failure means the assets dir is missing for
  // all — if NONE resolve, skip exactly like the prior single-bundle path.
  const resolvedBundles: Array<{ id: BundleId; sourceDir: string }> = [];
  let lastResolveError: string | null = null;
  for (const bundleId of USER_GLOBAL_BUNDLE_IDS) {
    try {
      resolvedBundles.push({ id: bundleId, sourceDir: deps.resolveUserBundledSkillDir(bundleId) });
    } catch (err) {
      lastResolveError = err instanceof Error ? err.message : String(err);
    }
  }
  if (resolvedBundles.length === 0) {
    logger({
      event: 'user-skill-reclaim-bundle-missing',
      scope: 'user',
      error: lastResolveError ?? 'no user-global bundles',
    });
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      outcome: 'failed',
      reason: `bundle-missing:${lastResolveError}`,
    });
    return { outcome: 'skipped', reason: 'bundle-missing' };
  }

  // Per-bundle opt-in gate — identical policy to the desktop reclaim. Declined
  // bundles are removed and skipped; unrecorded bundles grandfather to disk
  // presence (existing install stays + records the decision). Runs BEFORE the
  // version fast-path so a decline is honored even when the recorded version is
  // current.
  const gatedBundles: Array<{ id: BundleId; sourceDir: string }> = [];
  for (const bundle of resolvedBundles) {
    const name = BUNDLE_SKILL_NAME[bundle.id];
    const onDisk = userBundleExists(home, name, fs);
    const decision = await deps.readBundleDecision(home, name).catch(() => null);
    if (!resolveBundleEnabled(decision, { installedOnDisk: onDisk })) {
      if (onDisk) {
        try {
          deps.removeBundleFromDisk(home, bundle.id);
          logger({
            event: 'user-skill-reclaim-bundle-declined-removed',
            scope: 'user',
            bundle: bundle.id,
          });
        } catch (err) {
          logger({
            event: 'user-skill-reclaim-bundle-remove-failed',
            scope: 'user',
            bundle: bundle.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }
    if (decision === null && onDisk) {
      // Materialize the grandfathered decision. Fail-soft (the bundle stays
      // installed regardless), but log so a persistently unwritable state file
      // — which re-enters this path every boot — leaves a trail.
      try {
        await deps.writeBundleDecision(home, name, true);
      } catch (err) {
        logger({
          event: 'user-skill-reclaim-grandfather-write-failed',
          scope: 'user',
          bundle: bundle.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    gatedBundles.push(bundle);
  }
  if (gatedBundles.length === 0) {
    return { outcome: 'skipped', reason: 'all-bundles-declined' };
  }

  // Version fast-path — skip the copy only when the recorded version is current
  // AND every enabled bundle is already on disk (a freshly-enabled bundle must
  // install even at the current version).
  const allEnabledOnDisk = gatedBundles.every((b) =>
    userBundleExists(home, BUNDLE_SKILL_NAME[b.id], fs),
  );
  if (recordedVersion !== null && recordedVersion === bundledVersion && allEnabledOnDisk) {
    logger({
      event: 'user-skill-reclaim-skipped-version-current',
      scope: 'user',
      version: bundledVersion,
    });
    // No JSONL event on the version-current fast-path — a version-current skip
    // is provably equivalent to the prior successful write, so logging it again
    // is pure noise. (See the pre-existing rationale retained from the eager path.)
    return { outcome: 'skipped', reason: 'version-current' };
  }

  // Force-install each enabled bundle into the central store + per-host dirs.
  const entries: UserSkillEntry[] = [];
  // Two independent conditions gate the version advance, tracked separately so
  // the gate below reads plainly. (1) Every user-global bundle resolved — a
  // bundle that failed to resolve (rare — assets partially present) must leave
  // the version unrecorded so the next boot retries. Declined bundles are
  // excluded by choice, not failure, so they don't block the advance.
  const allBundlesResolved = resolvedBundles.length === USER_GLOBAL_BUNDLE_IDS.length;
  // (2) At least one authorized destination accepted EACH gated bundle —
  // tracked per bundle, never over the pooled entry list. Pooled, a sibling's
  // `skipped-present` satisfies the gate for a bundle whose only write threw,
  // and that bundle then reports `skip-current` instead of `failed`.
  const bundleResults: Array<{
    id: BundleId;
    anyWritten: boolean;
    landed: boolean;
    centralFailed: boolean;
    hostFailed: boolean;
  }> = [];
  for (const { id, sourceDir } of gatedBundles) {
    const result = installUserBundleToHostDirs(
      home,
      BUNDLE_SKILL_NAME[id],
      sourceDir,
      fs,
      logger,
      bundledVersion,
    );
    entries.push(...result.entries);
    bundleResults.push({
      id,
      anyWritten: result.anyWritten,
      landed: result.anyDestinationSucceeded,
      centralFailed: result.entries.some((e) => e.kind === 'central' && e.outcome === 'failed'),
      hostFailed: result.entries.some((e) => e.kind === 'host' && e.outcome === 'failed'),
    });
  }

  // Seed-if-absent: advance only after every gated bundle reached a usable
  // destination and no central write failed. Otherwise a no-host pass would
  // record the version and prevent repair when an editor is installed later.
  const anyCentralFailed = bundleResults.some((b) => b.centralFailed);
  const allBundlesLanded = bundleResults.every((b) => b.landed);
  if (allBundlesResolved && allBundlesLanded && !anyCentralFailed) {
    let stateWriteError: string | null = null;
    try {
      await deps.writeRecordedVersion(home, bundledVersion);
      logger({
        event: 'user-skill-reclaim-version-recorded',
        scope: 'user',
        version: bundledVersion,
      });
    } catch (err) {
      stateWriteError = err instanceof Error ? err.message : String(err);
      logger({
        event: 'user-skill-reclaim-version-record-failed',
        scope: 'user',
        version: bundledVersion,
        error: stateWriteError,
      });
    }
    // One outcome event per bundle, gated on the state-file write: `installed`
    // for a fresh seed, `skip-current` for a built-in that was already present.
    for (const { id, anyWritten } of bundleResults) {
      recordEventSoft({
        ts: nowIso(),
        surface: 'cli-start',
        target: 'cli-hosts',
        bundle: id,
        outcome: stateWriteError !== null ? 'failed' : anyWritten ? 'installed' : 'skip-current',
        version: bundledVersion,
        ...(stateWriteError === null ? {} : { reason: `state-write-failed:${stateWriteError}` }),
      });
    }
  } else {
    // Two independent causes land here and the reason has to name which: a
    // bundle whose assets never resolved (nothing was even attempted for it —
    // partially-present assets, so retry next boot) or a write that threw. The
    // write case is reported per bundle, because a bundle that landed nowhere
    // must not be masked by a sibling that did. A bundle that landed cleanly
    // gets no event: the version was not recorded, so nothing may claim it was.
    if (!allBundlesResolved) {
      recordEventSoft({
        ts: nowIso(),
        surface: 'cli-start',
        target: 'cli-hosts',
        outcome: 'failed',
        version: bundledVersion,
        reason: 'bundle-unresolved',
      });
    }
    for (const { id, centralFailed, hostFailed } of bundleResults) {
      if (!centralFailed && !hostFailed) continue;
      recordEventSoft({
        ts: nowIso(),
        surface: 'cli-start',
        target: 'cli-hosts',
        bundle: id,
        outcome: 'failed',
        version: bundledVersion,
        reason: hostFailed ? 'all-writes-failed' : 'central-write-failed',
      });
    }
  }

  return { outcome: 'done', version: bundledVersion, entries };
}

/**
 * Sweep both project-local and user-global SKILL.md files forward to today's
 * bundled version. Invoked from `bootStartServer` on every `ok start` boot
 * and from the standalone `ok repair-skills` subcommand.
 *
 * Project sweep: leaves a host's SKILL.md untouched when one already exists,
 * and creates it for any host whose project MCP config is OK-wired (carries
 * `# ok-mcp-v1`) but has none. Greenfield / non-OK-wired hosts untouched.
 *
 * User sweep: seed-if-absent, version-gated against `~/.ok/skill-state.yml`'s
 * `cli-hosts` entry — skipped early when the recorded version equals the bundled
 * version and every enabled built-in is already on disk.
 *
 * `OK_RECLAIM_DISABLE=1` short-circuits the entire sweep. Mirrors the env
 * gate on the desktop's `reclaimUserSkillsOnLaunch` /
 * `reclaimProjectSkillsOnProjectOpen`.
 */
export async function repairSkills(ctx: RepairSkillsContext): Promise<RepairSkillsResult> {
  const logger = ctx.logger ?? defaultLogger;
  const fs = ctx.fs ?? defaultFsOps;
  const home = ctx.home ?? homedir();
  const deps: Required<RepairSkillsDeps> = { ...defaultDeps, ...ctx.deps };

  if (ctx.reclaimDisableEnv === '1') {
    // Event name shares the `*-repair-skipped` prefix with the sibling MCP +
    // launch.json sweeps so an operator can grep `*-repair-skipped` to find
    // every disabled sweep in one pass.
    logger({ event: 'skill-repair-skipped', reason: 'reclaim-disabled' });
    return { status: 'skipped', reason: 'reclaim-disabled' };
  }

  const project = runProjectSweep(ctx.projectDir, deps, fs, logger);
  const user = await runUserSweep(home, deps, fs, logger);
  // Explicit-invocation only, and consent-gated even then. `ok init` must never
  // delete from $HOME unasked — that would answer one scope violation with
  // another — and neither may this command without showing its work first.
  const legacyPlan = planLegacyFanoutSweep(home);
  let legacySwept: string[] = [];
  let legacyCleanupDeclined = false;
  let legacyCleanupFailed = false;
  if (legacyPlan.skillDirs.length > 0 || legacyPlan.emptyDirs.length > 0) {
    const approved = ctx.confirmLegacyCleanup ? await ctx.confirmLegacyCleanup(legacyPlan) : false;
    if (approved) {
      try {
        legacySwept = applyLegacyFanoutSweep(home, legacyPlan);
      } catch (err) {
        // `apply` re-validates the plan and throws rather than delete anything
        // it can't account for. That means a bug, not a user problem — surface
        // it as its own outcome (never as a decline) and carry on, because the
        // install is this command's real job.
        legacyCleanupFailed = true;
        logger({
          event: 'legacy-fanout-cleanup-refused',
          scope: 'user',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      for (const path of legacySwept) {
        logger({ event: 'legacy-fanout-path-removed', scope: 'user', path });
      }
    } else {
      legacyCleanupDeclined = true;
      logger({ event: 'legacy-fanout-cleanup-declined', scope: 'user' });
    }
  }

  return { status: 'done', project, user, legacySwept, legacyCleanupDeclined, legacyCleanupFailed };
}

/**
 * Map a `RepairSkillsResult` to a process exit code. `Skipped:
 * reclaim-disabled` exits 0 (user explicitly opted out), every other failure
 * mode (bundle-missing, version-read-failed, any per-host failure) exits 1
 * so wrapper scripts and `&&`-chains observe the error.
 */
function repairSkillsResultExitCode(result: RepairSkillsResult): number {
  if (result.status === 'skipped') {
    // Top-level skip is only the env kill-switch — an intentional opt-out.
    return result.reason === 'reclaim-disabled' ? 0 : 1;
  }
  if (result.project.outcome === 'skipped') return 1;
  // `all-bundles-declined` arrives here as a user-sweep skip (result.user), NOT
  // a top-level one. Like `version-current` it is a supported success state
  // (the user opted out of every skill), so it must exit 0 — a non-zero exit
  // would break `&&`-chains and CI gates. Every other user-sweep skip is a real
  // failure.
  if (
    result.user.outcome === 'skipped' &&
    result.user.reason !== 'version-current' &&
    result.user.reason !== 'all-bundles-declined'
  ) {
    return 1;
  }
  if (result.project.entries.some((e) => e.outcome === 'failed')) return 1;
  if (result.user.outcome === 'done' && result.user.entries.some((e) => e.outcome === 'failed'))
    return 1;
  return 0;
}

function formatRepairSkillsResult(result: RepairSkillsResult): string {
  if (result.status === 'skipped') {
    return `Skipped: ${result.reason}`;
  }
  const lines: string[] = ['Skill reclaim complete.'];
  if (result.project.outcome === 'done') {
    const present = result.project.entries.filter((e) => e.outcome === 'present').length;
    const created = result.project.entries.filter((e) => e.outcome === 'created').length;
    const noToken = result.project.entries.filter((e) => e.outcome === 'no-token').length;
    const failed = result.project.entries.filter((e) => e.outcome === 'failed').length;
    lines.push(
      `  Project: ${present} present, ${created} created, ${noToken} no-token, ${failed} failed.`,
    );
  } else {
    lines.push(`  Project: skipped (${result.project.reason}).`);
  }
  if (result.user.outcome === 'done') {
    const written = result.user.entries.filter((e) => e.outcome === 'written').length;
    const present = result.user.entries.filter((e) => e.outcome === 'skipped-present').length;
    const skipped = result.user.entries.filter(
      (e) => e.outcome === 'skipped-host-absent' || e.outcome === 'skipped-collapsed-with-central',
    ).length;
    const failed = result.user.entries.filter((e) => e.outcome === 'failed').length;
    lines.push(
      `  User (${result.user.version}): ${written} written, ${present} present, ${skipped} skipped, ${failed} failed.`,
    );
  } else {
    lines.push(`  User: skipped (${result.user.reason}).`);
  }
  if (result.legacySwept.length > 0) {
    lines.push(`  Cleanup: removed ${result.legacySwept.length} path(s) from a pre-0.42 install.`);
  } else if (result.legacyCleanupFailed) {
    lines.push('  Cleanup: failed — see logs; pre-0.42 directories left in place.');
  } else if (result.legacyCleanupDeclined) {
    lines.push('  Cleanup: declined — pre-0.42 directories left in place.');
  }
  return lines.join('\n');
}

export function repairSkillsCommand(): Command {
  // No subcommand-level `--cwd` — the program-level `--cwd` (see `cli.ts`)
  // `process.chdir`s in its preAction hook before any subcommand action runs,
  // so `process.cwd()` already reflects the user's choice. Duplicating it
  // here would split semantics when both flags are passed simultaneously.
  return new Command('repair-skills')
    .description(
      'Refresh bundled SKILL.md files for installed AI editors (project-local + user-global). Runs automatically during `ok start`; this command forces an explicit sweep.',
    )
    .option(
      '-y, --yes',
      'Skip the confirmation prompt for removing directories left by a pre-0.42 install.',
    )
    .action(async (opts: { yes?: boolean }) => {
      const result = await repairSkills({
        projectDir: resolvePath(process.cwd()),
        reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
        confirmLegacyCleanup: (plan) => confirmLegacyCleanup(plan, { yes: opts.yes === true }),
      });
      process.stdout.write(`${formatRepairSkillsResult(result)}\n`);
      // process.exitCode (not process.exit) so any pending stdout/stderr
      // flushes still complete before Node tears down.
      process.exitCode = repairSkillsResultExitCode(result);
    });
}

/**
 * Show exactly what the pre-0.42 cleanup would delete and ask before doing it.
 *
 * Two things the user must be able to see BEFORE consenting, because the whole
 * point of issue #820 was software touching `$HOME` beyond what the user
 * pictured: every path is listed (not just a count), and each agent home is
 * labelled with WHY it is going — it holds nothing but OK's own skill, so it is
 * empty the moment that skill is removed.
 *
 * Non-interactive (piped/CI) without `--yes` declines rather than proceeding:
 * an unattended run must never delete from a home directory on a default.
 */
async function confirmLegacyCleanup(
  plan: LegacyFanoutSweepPlan,
  opts: { yes: boolean; input?: NodeJS.ReadableStream & { isTTY?: boolean } },
): Promise<boolean> {
  const home = homedir();
  const show = (p: string) => `~/${relative(home, p)}`;
  const input = opts.input ?? process.stdin;

  const lines: string[] = [
    '',
    accent(
      'A previous version of OpenKnowledge installed its skill into agent tools you may never have used.',
    ),
    dim(
      '(Versions before 0.42 wrote to every host a third-party installer knew about — see issue #820.)',
    ),
  ];
  if (plan.skillDirs.length > 0) {
    lines.push(
      '',
      `${accent('Remove OpenKnowledge skills:')} ${plan.skillDirs.length}`,
      ...plan.skillDirs.map((p) => `  ${show(p)}`),
    );
  }
  if (plan.emptyDirs.length > 0) {
    // Wording depends on whether skills are going too. A machine swept by an
    // earlier build already has them gone, and telling that user these dirs
    // are empty "once the above are gone" would describe a step not happening.
    const heading =
      plan.skillDirs.length > 0
        ? 'Then remove these, which hold nothing else once the above are gone:'
        : 'Remove these empty directories, left behind by that install:';
    lines.push(
      '',
      `${accent(heading)} ${plan.emptyDirs.length}`,
      ...plan.emptyDirs.map((p) => `  ${show(p)}`),
    );
  }
  lines.push(
    '',
    dim('Nothing outside these paths is touched. A directory that still holds anything is kept.'),
  );
  process.stdout.write(`${lines.join('\n')}\n`);

  if (opts.yes) return true;
  if (!input.isTTY) {
    process.stdout.write(
      `${warning('Not a terminal — skipping cleanup. Re-run with `ok repair-skills --yes` to remove these.')}\n`,
    );
    return false;
  }

  const rl = createInterface({ input, output: process.stdout });
  try {
    const answer = (await rl.question(`\n${accent('Remove them?')} ${dim('[y/N] ')}`))
      .trim()
      .toLowerCase();
    // Default NO — deletion is never the answer to an empty Enter.
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export const __testing = {
  HOSTS_WITH_USER_SKILL_DIR,
  USER_SKILL_HOSTS,
  USER_SKILL_DIR_NAME,
  PROJECT_SKILL_DIR_NAME,
  CENTRAL_USER_SKILL_REL,
  formatRepairSkillsResult,
  repairSkillsResultExitCode,
  confirmLegacyCleanup,
};
