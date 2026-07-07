/**
 * User-level + project-level Agent Skill reclaim, PATH-independent.
 *
 * Why this exists: the prior path (`installUserSkill` → `npx -y skills@~1.5.0
 * add … --agent '*' -g --copy`) only succeeds when `npx` is on the spawn
 * env's PATH. macOS GUI launches (Dock click, LaunchServices, `open -b`)
 * carry the minimal GUI PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — Node/npm
 * installed under `/opt/homebrew/bin` or `~/.nvm/…` is invisible. The
 * subprocess `ENOENT`s, the fire-and-forget catch in `index.ts` swallows
 * it, and `~/.ok/skill-state.yml` never advances past whichever version a
 * past `ok init` (in a terminal with full PATH) recorded. Confirmed in
 * `~/.ok/skill-install-events.jsonl` — desktop-direct entries show
 * `outcome: "failed", reason: "spawn-error"` across multiple beta cuts.
 *
 * Fix: copy the bundled SKILL directory directly into the same on-disk
 * locations `npx skills add --copy` produces. No subprocess; no PATH
 * dependency; tracks the bundled version on every launch.
 *
 * Two bundles ship side by side: the user-global scope installs the slim
 * `discovery` bundle; the project-local scope installs the rich `project`
 * bundle. The two take different dir names so they cannot shadow each other.
 *
 * On-disk layout this mirrors (user scope — slim `discovery` bundle):
 *   - `<home>/.agents/skills/open-knowledge-discovery/` — central store;
 *     `centralSkillExists` in `skill-install.ts` keys off this dir.
 *   - `<home>/.<host>/skills/open-knowledge-discovery/` — per-host copy.
 *     Today's set is {claude, cursor, codex(`.codex`)}.
 * Any pre-split `<home>/.<host>/skills/open-knowledge/` dir is removed first
 * (legacy migration).
 *
 * Project-scope variant: same primitive, scoped to `<projectDir>/.<host>/
 * skills/open-knowledge/` — the rich `project` bundle keeps `name:
 * open-knowledge` so the dir name is unchanged. Per-host gate: always refresh
 * a host whose `SKILL.md` already exists; additionally, when `createIfWired`
 * is set (managed-project opens only), CREATE the skill for any host whose
 * project MCP config already carries the OK marker. This heals the cohort of
 * managed projects onboarded before the project-skill writer existed — they
 * have OK MCP wiring but no skill, and the old no-create gate never fixed
 * them. Non-OK folders (no marker) and greenfield hosts still get nothing.
 *
 * Surface attribution recorded as `desktop-direct` so the existing event-log
 * vocabulary stays one set across `installUserSkill` and this writer.
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
import { dirname, join } from 'node:path';
import {
  assertProjectPathSafe,
  EDITOR_TARGETS,
  HOSTS_WITH_USER_SKILL_DIR,
} from '@inkeep/open-knowledge';
import { resolveBundleEnabled } from '@inkeep/open-knowledge-core';

interface SkillReclaimLogger {
  event(payload: { event: string; [key: string]: unknown }): void;
  warn(message: string, ctx?: object): void;
}

const DEFAULT_LOGGER: SkillReclaimLogger = {
  event: (payload) => console.warn(JSON.stringify(payload)),
  warn: (message, ctx) => console.warn('[skill-reclaim]', message, ctx ?? ''),
};

// `HOSTS_WITH_USER_SKILL_DIR` (host-dir + editorId for each project-skill editor)
// is the canonical core constant, imported via the package surface — shared
// verbatim with the CLI `repair-skills` sweep. It is DERIVED from
// PROJECT_SKILL_EDITOR_IDS + EDITOR_PROJECT_SKILL_ROOT, so it can no longer drift
// from the CLI sibling (this list and the CLI's were previously hand-maintained
// literals kept in lockstep by comment + a one-sided meta-test).

/**
 * The version sentinel that `ok init` / project-setup writes as the first line
 * of every managed MCP server entry's resilient-chain body. Substring-present
 * in both the JSON (`.mcp.json`, `.cursor/mcp.json`) and TOML
 * (`.codex/config.toml`) on-disk forms. The `createIfWired` gate treats its
 * presence in an editor's project config as proof the editor is wired for this
 * OK project. Same string as `CHAIN_VERSION_SENTINEL` in the CLI's `editors.ts`,
 * kept as a local copy because that sentinel is `@internal` and deliberately
 * not re-exported from `@inkeep/open-knowledge`; if it ever bumps (`v2`, …),
 * update this copy in the same change.
 */
const OK_MCP_MARKER = '# ok-mcp-v1';

/**
 * Windows sibling of `OK_MCP_MARKER` (`CHAIN_WIN_VERSION_SENTINEL` in the
 * CLI's `editors.ts`) — same local-copy rule as above. A shared project
 * config written by a Windows teammate carries this sentinel instead; both
 * count as "wired for OK".
 */
const OK_MCP_WIN_MARKER = '# ok-mcp-win-v1';

/**
 * Project-local install dir name. The rich `project` bundle keeps
 * `name: open-knowledge`, so the project-scope dir stays `open-knowledge` —
 * only the user-global dir takes the `-discovery` suffix.
 */
const PROJECT_SKILL_DIR_NAME = 'open-knowledge';
/**
 * Pre-split skill dir name. The legacy migration removes any user-global
 * install under this name before the `discovery` bundle lands. Sibling
 * constant: `LEGACY_USER_SKILL_NAME` in
 * `packages/server/src/skill-install.ts` (kept separate so this desktop
 * module stays free of server imports).
 */
const LEGACY_SKILL_DIR_NAME = 'open-knowledge';

interface SkillFsOps {
  existsSync(path: string): boolean;
  /** Returns true iff the path is a directory (asar shim handles this). */
  isDirectory(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, content: Buffer): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

const defaultFsOps: SkillFsOps = {
  existsSync: (path) => fsExistsSync(path),
  isDirectory: (path) => {
    try {
      return fsStatSync(path).isDirectory();
    } catch {
      return false;
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

/**
 * Replace the directory at `destDir` with a recursive copy of `sourceDir`.
 *
 * Walks via `readdirSync` + `readFileSync` + `writeFileSync` rather than
 * `cpSync`. `cpSync`'s internal recursion does not interoperate with
 * Electron's asar fs-shim — when `sourceDir` resolves inside the bundled
 * `app.asar`, `cpSync` ENOENTs on the relative path lookup even though
 * `existsSync`/`statSync`/`readdirSync` on the same path succeed via the
 * shim. The bundled SKILL ships inside the asar (no `asarUnpack` entry
 * for `assets/skills/**`), so an asar-compatible copy is mandatory.
 *
 * The `rmSync` is load-bearing — a manual walk that only overwrote
 * existing files would leave orphans on disk when a SKILL bump drops a
 * file. Wipe-then-copy collapses both the freshness and the orphan-
 * removal contracts into one step.
 */
function replaceDir(sourceDir: string, destDir: string, fs: SkillFsOps): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(dirname(destDir), { recursive: true });
  copyDirContents(sourceDir, destDir, fs);
}

function copyDirContents(sourceDir: string, destDir: string, fs: SkillFsOps): void {
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
 * Legacy migration: remove any pre-split user-global `open-knowledge` skill
 * dir (`~/.{claude,cursor,agents}/skills/open-knowledge/`) before the new
 * `open-knowledge-discovery` bundle lands. Direct `rmSync` — PATH-independent,
 * no `npx` shell-out. Idempotent: a no-op when the dir is already absent.
 * Failures are logged + swallowed.
 */
function removeLegacyUserSkillDirs(home: string, fs: SkillFsOps, logger: SkillReclaimLogger): void {
  // Sweep each install host PLUS `.agents` — the central store's parent, and
  // codex's former home before it moved to `.codex`. A pre-split
  // `~/.agents/skills/open-knowledge` (the central store's old name) must
  // still be cleaned even though `.agents` is no longer a per-host install dir.
  const legacyHostDirs = [...HOSTS_WITH_USER_SKILL_DIR.map((h) => h.hostDir), '.agents'];
  for (const hostDir of legacyHostDirs) {
    const legacyDir = join(home, hostDir, 'skills', LEGACY_SKILL_DIR_NAME);
    if (!fs.existsSync(legacyDir)) continue;
    try {
      fs.rmSync(legacyDir, { recursive: true, force: true });
      logger.event({ event: 'user-skill-reclaim-legacy-removed', path: legacyDir });
    } catch (err) {
      // Structured `logger.event` (not just `logger.warn`) so the failure
      // lands in the JSONL log alongside the success event above and the
      // sibling central/host failure events — operators tail one stream.
      logger.event({
        event: 'user-skill-reclaim-legacy-remove-failed',
        path: legacyDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// User-level reclaim
// ---------------------------------------------------------------------------

type UserSkillReclaimEntry =
  | { kind: 'central'; path: string; status: 'written' | 'overwritten' | 'failed'; error?: string }
  | {
      kind: 'host';
      hostDir: string;
      editorId: string;
      path: string;
      status: 'written' | 'overwritten' | 'skipped-host-absent' | 'failed';
      error?: string;
    };

type UserSkillReclaimResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; version: string; entries: UserSkillReclaimEntry[] };

interface ReclaimUserSkillsOpts {
  home: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  /** `app.getPath('exe')` — must match `.app/Contents/MacOS/<name>` in production. */
  executablePath: string;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  /** DI for cross-package primitives so unit tests can substitute. */
  deps: {
    /** The user-global built-in bundles to install (id + install dir name).
     *  Wired from core's `USER_GLOBAL_BUNDLE_IDS` by the caller — this module
     *  stays free of server/core imports. */
    userGlobalBundles: ReadonlyArray<{ id: string; name: string }>;
    resolveBundledSkillDir(bundle: string): string;
    readServerPackageVersion(): Promise<string>;
    /** Per-bundle opt-in gate (server `readBundleDecision`): explicit
     *  recorded enablement, or null when unrecorded. Injected so this module
     *  stays free of server imports. */
    readBundleDecision(home: string, bundleName: string): Promise<boolean | null>;
    /** Materialize a grandfathered install's decision (server
     *  `writeBundleDecision`) so later actors agree it's opted in. */
    writeBundleDecision(home: string, bundleName: string, enabled: boolean): Promise<void>;
    /** Remove a declined bundle's dirs from disk (CLI
     *  `removeUserGlobalSkillBundle`). Keyed by bundle id. */
    removeBundleFromDisk(bundleId: string): void;
    writeTargetVersion(
      home: string,
      target: 'cli-hosts',
      version: string,
      surface: 'desktop-direct',
    ): Promise<void>;
    recordSkillInstallEvent(event: {
      ts: string;
      surface: 'desktop-direct';
      target: 'cli-hosts';
      bundle?: string;
      outcome: 'installed' | 'failed';
      version?: string;
      reason?: string;
    }): Promise<void>;
  };
  fs?: SkillFsOps;
  now?: () => Date;
  logger?: SkillReclaimLogger;
}

/**
 * Force-write ONE user-global bundle into the central store + every detected
 * per-host directory, under its own `bundleDirName`. Returns the per-write
 * entries (the version-advance gate keys off `anyWriteSucceeded` across all
 * bundles). Looped over `deps.userGlobalBundles` so discovery + write-skill
 * both land.
 */
function installUserBundleToHostDirs(
  home: string,
  bundleDirName: string,
  sourceDir: string,
  fs: SkillFsOps,
  logger: SkillReclaimLogger,
  version: string,
): UserSkillReclaimEntry[] {
  const entries: UserSkillReclaimEntry[] = [];
  const centralDest = join(home, '.agents', 'skills', bundleDirName);
  const centralExistedBefore = fs.existsSync(centralDest);
  try {
    replaceDir(sourceDir, centralDest, fs);
    entries.push({
      kind: 'central',
      path: centralDest,
      status: centralExistedBefore ? 'overwritten' : 'written',
    });
    logger.event({
      event: 'user-skill-reclaim-central-written',
      path: centralDest,
      preexisting: centralExistedBefore,
      version,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    entries.push({ kind: 'central', path: centralDest, status: 'failed', error });
    logger.event({ event: 'user-skill-reclaim-central-failed', path: centralDest, error });
  }

  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(hostRoot, 'skills', bundleDirName);
    if (hostDest === centralDest) {
      // Defensive: skip a per-host write that resolves to the central store's
      // own path (would be a redundant double-write of the same bytes). No
      // host root currently coincides with `.agents`, but the guard keeps the
      // central write authoritative if that ever changes.
      continue;
    }
    if (!fs.existsSync(hostRoot)) {
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'skipped-host-absent',
      });
      continue;
    }
    const existedBefore = fs.existsSync(hostDest);
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: existedBefore ? 'overwritten' : 'written',
      });
      logger.event({
        event: 'user-skill-reclaim-host-written',
        editorId: host.editorId,
        path: hostDest,
        preexisting: existedBefore,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'failed',
        error,
      });
      logger.event({
        event: 'user-skill-reclaim-host-failed',
        editorId: host.editorId,
        path: hostDest,
        error,
      });
    }
  }
  return entries;
}

/**
 * Force-write the bundled SKILL into the user-level central store and into
 * every detected per-host directory. Always overwrites — no version-skip
 * gate. Records progress to `~/.ok/skill-state.yml` and the JSONL event log
 * even on partial failure (state advances on the central store write; per-
 * host failures don't roll back).
 */
export async function reclaimUserSkillsOnLaunch(
  opts: ReclaimUserSkillsOpts,
): Promise<UserSkillReclaimResult> {
  const {
    home,
    isPackaged,
    platform,
    executablePath,
    forceEnv,
    reclaimDisableEnv,
    deps,
    fs = defaultFsOps,
    now,
    logger = DEFAULT_LOGGER,
  } = opts;
  const nowDate = (): Date => (now ? now() : new Date());

  if (reclaimDisableEnv === '1') return { status: 'skipped', reason: 'reclaim-disabled' };
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    return { status: 'skipped', reason: 'bad-executable-path' };
  }

  // Resolve every user-global built-in bundle's source up front (discovery +
  // write-skill, wired from core's `USER_GLOBAL_BUNDLE_IDS`). The bundles ship
  // together, so if NONE resolve the assets dir is missing — skip exactly like
  // the prior single-bundle path.
  const resolvedBundles: Array<{ id: string; name: string; sourceDir: string }> = [];
  let lastResolveError: string | null = null;
  for (const bundle of deps.userGlobalBundles) {
    try {
      resolvedBundles.push({ ...bundle, sourceDir: deps.resolveBundledSkillDir(bundle.id) });
    } catch (err) {
      lastResolveError = err instanceof Error ? err.message : String(err);
    }
  }
  if (resolvedBundles.length === 0) {
    logger.event({
      event: 'user-skill-reclaim-bundle-missing',
      error: lastResolveError ?? 'no user-global bundles',
    });
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        outcome: 'failed',
        reason: `bundle-missing:${lastResolveError}`,
      })
      .catch(() => {
        /* telemetry must never affect install outcomes */
      });
    return { status: 'skipped', reason: 'bundle-missing' };
  }

  let version: string;
  try {
    version = await deps.readServerPackageVersion();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.event({ event: 'user-skill-reclaim-version-read-failed', error });
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        bundle: 'discovery',
        outcome: 'failed',
        reason: `version-read-failed:${error}`,
      })
      .catch(() => {});
    return { status: 'skipped', reason: 'version-read-failed' };
  }

  // Drop any pre-split `open-knowledge` user-global install before the new
  // `open-knowledge-discovery` bundle lands. Fail-soft.
  removeLegacyUserSkillDirs(home, fs, logger);

  // Per-bundle opt-in gate. Explicit decline (`enabled: false`) is removed and
  // never re-installed; an unrecorded bundle grandfathers to disk presence
  // (existing install stays + records the decision, a truly-fresh machine
  // stays uninstalled until the first-launch dialog records consent). This is
  // the launch-side half of the cross-actor invariant — the CLI sweep applies
  // the identical gate.
  const gatedBundles: typeof resolvedBundles = [];
  for (const bundle of resolvedBundles) {
    const onDisk = fs.existsSync(join(home, '.agents', 'skills', bundle.name));
    const decision = await deps.readBundleDecision(home, bundle.name).catch(() => null);
    if (!resolveBundleEnabled(decision, { installedOnDisk: onDisk })) {
      if (onDisk) {
        try {
          deps.removeBundleFromDisk(bundle.id);
          logger.event({ event: 'user-skill-reclaim-bundle-declined-removed', bundle: bundle.id });
        } catch (err) {
          logger.event({
            event: 'user-skill-reclaim-bundle-remove-failed',
            bundle: bundle.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }
    if (decision === null && onDisk) {
      // Grandfather: record so later actors don't treat it as fresh. Fail-soft
      // (the bundle stays installed regardless), but log so a persistently
      // unwritable state file — which re-enters this path every launch —
      // leaves a trail instead of retrying invisibly forever.
      try {
        await deps.writeBundleDecision(home, bundle.name, true);
      } catch (err) {
        logger.event({
          event: 'user-skill-reclaim-grandfather-write-failed',
          bundle: bundle.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    gatedBundles.push(bundle);
  }

  if (gatedBundles.length === 0) {
    return { status: 'skipped', reason: 'all-bundles-declined' };
  }

  // Force-install each enabled user-global bundle (discovery + write-skill)
  // into the central store + per-host dirs, each under its own name.
  const entries: UserSkillReclaimEntry[] = [];
  for (const bundle of gatedBundles) {
    entries.push(
      ...installUserBundleToHostDirs(home, bundle.name, bundle.sourceDir, fs, logger, version),
    );
  }

  const anyWriteSucceeded = entries.some(
    (e) => e.status === 'written' || e.status === 'overwritten',
  );
  if (anyWriteSucceeded) {
    let stateWriteError: string | null = null;
    try {
      await deps.writeTargetVersion(home, 'cli-hosts', version, 'desktop-direct');
    } catch (err) {
      stateWriteError = err instanceof Error ? err.message : String(err);
      logger.warn('writeTargetVersion failed', { error: stateWriteError });
    }
    // Gate the JSONL outcome on the state-file write. A failed
    // writeTargetVersion with outcome:'installed' would recreate the exact
    // staleness symptom this whole module is fixing — the event log would
    // claim success while `~/.ok/skill-state.yml` stays pinned to a stale
    // version. Force-write on the next launch self-heals the on-disk
    // SKILL.md content, but the diagnostic trail (event log says installed,
    // state file disagrees) would mislead operators chasing a "did the
    // skill update?" question.
    // One outcome event per installed bundle, gated on the state-file write.
    for (const bundle of gatedBundles) {
      await deps
        .recordSkillInstallEvent({
          ts: nowDate().toISOString(),
          surface: 'desktop-direct',
          target: 'cli-hosts',
          bundle: bundle.id,
          outcome: stateWriteError === null ? 'installed' : 'failed',
          version,
          ...(stateWriteError === null ? {} : { reason: `state-write-failed:${stateWriteError}` }),
        })
        .catch(() => {});
    }
  } else {
    await deps
      .recordSkillInstallEvent({
        ts: nowDate().toISOString(),
        surface: 'desktop-direct',
        target: 'cli-hosts',
        outcome: 'failed',
        version,
        reason: 'all-targets-failed',
      })
      .catch(() => {});
  }

  return { status: 'done', version, entries };
}

// ---------------------------------------------------------------------------
// Project-level reclaim
// ---------------------------------------------------------------------------

type ProjectSkillReclaimEntry = {
  editorId: string;
  hostDir: string;
  path: string;
  status: 'no-token' | 'reclaimed' | 'created' | 'failed';
  error?: string;
};

type ProjectSkillReclaimResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; entries: ProjectSkillReclaimEntry[] };

interface ReclaimProjectSkillsOpts {
  projectDir: string;
  executablePath: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  /**
   * Widen the per-host gate from "SKILL.md already exists" to also create the
   * skill when that editor's project-local MCP config carries the OK marker
   * (`OK_MCP_MARKER`). Set ONLY for managed-project opens — the caller in
   * `index.ts` passes it for `discovery.kind === 'managed' |
   * 'managed-requires-confirmation'` (after any confirmation). Left `false`
   * (default) the function keeps its original no-create refresh behavior, so a
   * non-OK folder the user opens then cancels is never seeded.
   */
  createIfWired?: boolean;
  deps: {
    resolveBundledSkillDir(): string;
  };
  fs?: SkillFsOps;
  logger?: SkillReclaimLogger;
}

/**
 * True iff `configPath` exists and its bytes contain `OK_MCP_MARKER` — proof
 * the editor is wired for this OK project. Read via the injectable fs; a read
 * error (torn / unreadable config) classifies as "not wired" rather than
 * throwing, so one bad config never blocks the other hosts.
 *
 * Distinct from `isEntryUpToDate` (the structured JSON-entry predicate used in
 * `project-mcp-reclaim.ts` / `mcp-wiring.ts`): this check is intentionally
 * format-agnostic — the marker is substring-present in both the JSON
 * (`.mcp.json`, `.cursor/mcp.json`) and the TOML (`.codex/config.toml`) forms —
 * and looser: it detects any config carrying the marker, not a well-formed
 * MCP entry.
 */
function editorWiredForOk(configPath: string | undefined, fs: SkillFsOps): boolean {
  if (!configPath) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    const bytes = fs.readFileSync(configPath).toString('utf8');
    return bytes.includes(OK_MCP_MARKER) || bytes.includes(OK_MCP_WIN_MARKER);
  } catch {
    return false;
  }
}

/**
 * Project-scope SKILL reclaim. Per-host gate: write
 * `<projectDir>/.<host>/skills/open-knowledge/` when `SKILL.md` already exists
 * (refresh, always) OR — when `createIfWired` is set — when that editor's
 * project MCP config carries `OK_MCP_MARKER` (create; heals the managed
 * MCP-but-no-skill cohort). Without `createIfWired` this stays no-create:
 * greenfield / non-OK folders get nothing.
 */
export async function reclaimProjectSkillsOnProjectOpen(
  opts: ReclaimProjectSkillsOpts,
): Promise<ProjectSkillReclaimResult> {
  const {
    projectDir,
    executablePath,
    isPackaged,
    platform,
    forceEnv,
    reclaimDisableEnv,
    createIfWired = false,
    deps,
    fs = defaultFsOps,
    logger = DEFAULT_LOGGER,
  } = opts;

  if (reclaimDisableEnv === '1') return { status: 'skipped', reason: 'reclaim-disabled' };
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    return { status: 'skipped', reason: 'bad-executable-path' };
  }

  let sourceDir: string;
  try {
    sourceDir = deps.resolveBundledSkillDir();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.event({ event: 'project-skill-reclaim-bundle-missing', error });
    return { status: 'skipped', reason: 'bundle-missing' };
  }

  const entries: ProjectSkillReclaimEntry[] = [];
  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const dest = join(projectDir, host.hostDir, 'skills', PROJECT_SKILL_DIR_NAME);
    const skillFile = join(dest, 'SKILL.md');
    const skillExists = fs.existsSync(skillFile);
    // Create only when explicitly enabled AND the editor is OK-wired for this
    // project. The config path comes from `EDITOR_TARGETS` (single source of
    // truth); the read is skipped entirely on the refresh path.
    const projectConfigPath = EDITOR_TARGETS[host.editorId]?.projectConfigPath?.(projectDir);
    const wired = !skillExists && createIfWired && editorWiredForOk(projectConfigPath, fs);
    if (!skillExists && !wired) {
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status: 'no-token',
      });
      logger.event({
        event: 'project-skill-reclaim-no-token',
        editorId: host.editorId,
        path: dest,
      });
      continue;
    }
    try {
      // Symlink-escape guard before `replaceDir`'s rmSync — a planted
      // `.claude -> /etc` (or symlinked ancestor escaping projectDir) must not
      // route the recursive removal + copy through the symlink target. Matters
      // most on the create path (fresh dir), but a planted SKILL.md symlink can
      // also satisfy the refresh gate, so guard both.
      assertProjectPathSafe(dest, projectDir);
      replaceDir(sourceDir, dest, fs);
      const status = skillExists ? 'reclaimed' : 'created';
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status,
      });
      logger.event({
        event: skillExists ? 'project-skill-reclaim-reclaimed' : 'project-skill-reclaim-created',
        editorId: host.editorId,
        path: dest,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status: 'failed',
        error,
      });
      logger.event({
        event: 'project-skill-reclaim-failed',
        editorId: host.editorId,
        path: dest,
        error,
      });
    }
  }

  return { status: 'done', entries };
}
