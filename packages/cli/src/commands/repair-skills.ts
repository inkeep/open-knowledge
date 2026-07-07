/**
 * CLI parity for the Desktop's skill-reclaim sweeps:
 *   - `reclaimProjectSkillsOnProjectOpen` (refresh existing SKILL.md + create
 *     for OK-wired editors; here it is always create-enabled because the sweep
 *     only ever runs inside a confirmed `.ok/` project)
 *   - `reclaimUserSkillsOnLaunch` (force-write user-global central + per-host)
 *
 * Why this exists: a teammate using only `@inkeep/open-knowledge` (no
 * Desktop install) sees `SKILL.md` written once by `ok init` and never
 * refreshed. The Desktop already has these two sweeps; this is the CLI
 * port. Wired into `bootStartServer` and exposed as `ok repair-skills` for
 * explicit invocation. Reference: packages/desktop/src/main/skill-reclaim.ts.
 *
 * Version-gate asymmetry with Desktop: the user-scope sweep here checks
 * `~/.ok/skill-state.yml`'s `cli-hosts` entry and skips when the recorded
 * version equals the bundled version. Desktop force-writes every launch.
 * Justified by invocation frequency — `ok start` runs many times per day
 * vs. an Electron app launching 1-2 times. The project-scope sweep is NOT
 * version-gated (drift via manual edits can outlast a version bump).
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
import { dirname, join, resolve as resolvePath } from 'node:path';
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
import { removeUserGlobalSkillBundle } from '../integrations/skill-teardown.ts';
import { assertProjectPathSafe } from '../integrations/write-project-skill.ts';
import {
  CHAIN_VERSION_SENTINEL,
  CHAIN_WIN_VERSION_SENTINEL,
  EDITOR_TARGETS,
  type EditorId,
  HOSTS_WITH_USER_SKILL_DIR,
} from './editors.ts';

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
}

export type ProjectSkillOutcome = 'no-token' | 'reclaimed' | 'created' | 'failed';
export type UserSkillCentralOutcome = 'written' | 'overwritten' | 'failed';
export type UserSkillHostOutcome =
  | 'written'
  | 'overwritten'
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

/**
 * Install ONE user-global bundle into the central store + each per-host dir,
 * under its own `bundleDirName`. Returns the per-write entries and whether the
 * CENTRAL write landed (the version-advance gate keys off every bundle's
 * central). Looped over `USER_GLOBAL_BUNDLE_IDS` by `runUserSweep` so each
 * user-global built-in (discovery + write-skill) is force-installed.
 */
function installUserBundleToHostDirs(
  home: string,
  bundleDirName: string,
  sourceDir: string,
  fs: RepairSkillsFsOps,
  logger: (event: RepairSkillsLogEvent) => void,
  version: string,
): { entries: UserSkillEntry[]; centralWritten: boolean } {
  const entries: UserSkillEntry[] = [];
  const centralDest = join(home, '.agents', 'skills', bundleDirName);
  const centralExistedBefore = fs.existsSync(centralDest);
  let centralWritten = false;
  try {
    replaceDir(sourceDir, centralDest, fs);
    centralWritten = true;
    entries.push({
      kind: 'central',
      path: centralDest,
      outcome: centralExistedBefore ? 'overwritten' : 'written',
    });
    logger({
      event: 'user-skill-reclaim-central-written',
      scope: 'user',
      path: centralDest,
      preexisting: centralExistedBefore,
      version,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    entries.push({ kind: 'central', path: centralDest, outcome: 'failed', error });
    logger({ event: 'user-skill-reclaim-central-failed', scope: 'user', path: centralDest, error });
  }

  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(hostRoot, 'skills', bundleDirName);
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
    const existedBefore = fs.existsSync(hostDest);
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        outcome: existedBefore ? 'overwritten' : 'written',
      });
      logger({
        event: 'user-skill-reclaim-host-written',
        scope: 'user',
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: hostDest,
        preexisting: existedBefore,
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
  return { entries, centralWritten };
}

/**
 * True iff `configPath` exists and its bytes contain either platform's chain
 * sentinel (`# ok-mcp-v1` / `# ok-mcp-win-v1`) — proof the editor is wired
 * for this OK project. The sentinel is the first line of every managed MCP
 * entry's resilient-chain body and is substring-present in both the JSON and
 * TOML on-disk forms, so a plain `includes` check is format-agnostic. Both
 * sentinels are accepted on every platform — a shared project config written
 * on the other OS still proves the editor is wired. A read error (torn /
 * unreadable config) classifies as "not wired" rather than throwing, so one
 * bad config never blocks the other hosts.
 */
function editorWiredForOk(configPath: string | undefined, fs: RepairSkillsFsOps): boolean {
  if (!configPath) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    const bytes = fs.readFileSync(configPath).toString('utf8');
    return bytes.includes(CHAIN_VERSION_SENTINEL) || bytes.includes(CHAIN_WIN_VERSION_SENTINEL);
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
    // Create only when the editor is OK-wired for this project. The config read
    // is skipped on the refresh path. The host's `editorId` is a valid
    // `EDITOR_TARGETS` key by the coverage meta-test, so the lookup +
    // `projectConfigPath` resolution reuse the single source of truth (no
    // duplicated per-editor path table).
    const projectConfigPath =
      EDITOR_TARGETS[host.editorId as EditorId]?.projectConfigPath?.(projectDir);
    const wired = !skillExists && editorWiredForOk(projectConfigPath, fs);
    if (!skillExists && !wired) {
      // Three scenarios surface here: (a) greenfield host that never ran
      // `ok init` AND isn't OK-wired — nothing to do; (b) a host wired for some
      // OTHER editor's MCP but not this one — also nothing; (c) the rare torn
      // case — a prior `replaceDir` crashed between `rmSync(dest)` and
      // `copyDirContents`, leaving the destination absent while the config
      // still carries the marker (this re-creates it via the `wired` path).
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
      const outcome: ProjectSkillOutcome = skillExists ? 'reclaimed' : 'created';
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        outcome,
      });
      logger({
        event: skillExists ? 'project-skill-reclaim-reclaimed' : 'project-skill-reclaim-created',
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
    const onDisk = fs.existsSync(join(home, '.agents', 'skills', name));
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
    fs.existsSync(join(home, '.agents', 'skills', BUNDLE_SKILL_NAME[b.id])),
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
  // (2) Every gated bundle's central write landed.
  let allGatedCentralsWritten = true;
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
    if (!result.centralWritten) allGatedCentralsWritten = false;
  }

  // Gate version advance on EVERY bundle's central write landing — the same
  // central-gate rationale, generalized across the bundle set. A partial
  // failure leaves the version unrecorded so the next boot retries; per-host
  // writes are idempotent (`replaceDir`). The Desktop has the same gate shape
  // but force-writes every launch (no version gate) so it self-heals.
  const anyCentralWritten = entries.some(
    (e) => e.kind === 'central' && (e.outcome === 'written' || e.outcome === 'overwritten'),
  );
  if (allBundlesResolved && allGatedCentralsWritten && anyCentralWritten) {
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
    // One outcome event per installed bundle, gated on the state-file write —
    // an `installed` event paired with a stale `skill-state.yml` would mislead
    // any operator chasing "did the install actually land?".
    for (const { id } of gatedBundles) {
      recordEventSoft({
        ts: nowIso(),
        surface: 'cli-start',
        target: 'cli-hosts',
        bundle: id,
        outcome: stateWriteError === null ? 'installed' : 'failed',
        version: bundledVersion,
        ...(stateWriteError === null ? {} : { reason: `state-write-failed:${stateWriteError}` }),
      });
    }
  } else {
    // central write failed for at least one bundle. Split the reason by whether
    // any HOST write actually threw vs every host being absent/collapsed.
    const anyHostFailed = entries.some((e) => e.kind === 'host' && e.outcome === 'failed');
    recordEventSoft({
      ts: nowIso(),
      surface: 'cli-start',
      target: 'cli-hosts',
      outcome: 'failed',
      version: bundledVersion,
      reason: anyHostFailed ? 'all-writes-failed' : 'no-hosts-installed',
    });
  }

  return { outcome: 'done', version: bundledVersion, entries };
}

/**
 * Sweep both project-local and user-global SKILL.md files forward to today's
 * bundled version. Invoked from `bootStartServer` on every `ok start` boot
 * and from the standalone `ok repair-skills` subcommand.
 *
 * Project sweep: refreshes a host's SKILL.md when one already exists, and
 * creates it for any host whose project MCP config is OK-wired (carries
 * `# ok-mcp-v1`). Greenfield / non-OK-wired hosts untouched.
 *
 * User sweep: version-gated against `~/.ok/skill-state.yml`'s `cli-hosts`
 * entry — skipped when the recorded version equals the bundled version.
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

  return { status: 'done', project, user };
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
    const reclaimed = result.project.entries.filter((e) => e.outcome === 'reclaimed').length;
    const created = result.project.entries.filter((e) => e.outcome === 'created').length;
    const noToken = result.project.entries.filter((e) => e.outcome === 'no-token').length;
    const failed = result.project.entries.filter((e) => e.outcome === 'failed').length;
    lines.push(
      `  Project: ${reclaimed} reclaimed, ${created} created, ${noToken} no-token, ${failed} failed.`,
    );
  } else {
    lines.push(`  Project: skipped (${result.project.reason}).`);
  }
  if (result.user.outcome === 'done') {
    const written = result.user.entries.filter(
      (e) => e.outcome === 'written' || e.outcome === 'overwritten',
    ).length;
    const skipped = result.user.entries.filter(
      (e) => e.outcome === 'skipped-host-absent' || e.outcome === 'skipped-collapsed-with-central',
    ).length;
    const failed = result.user.entries.filter((e) => e.outcome === 'failed').length;
    lines.push(
      `  User (${result.user.version}): ${written} written, ${skipped} skipped, ${failed} failed.`,
    );
  } else {
    lines.push(`  User: skipped (${result.user.reason}).`);
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
    .action(async () => {
      const result = await repairSkills({
        projectDir: resolvePath(process.cwd()),
        reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
      });
      process.stdout.write(`${formatRepairSkillsResult(result)}\n`);
      // process.exitCode (not process.exit) so any pending stdout/stderr
      // flushes still complete before Node tears down.
      process.exitCode = repairSkillsResultExitCode(result);
    });
}

export const __testing = {
  HOSTS_WITH_USER_SKILL_DIR,
  USER_SKILL_DIR_NAME,
  PROJECT_SKILL_DIR_NAME,
  CENTRAL_USER_SKILL_REL,
  formatRepairSkillsResult,
  repairSkillsResultExitCode,
};
