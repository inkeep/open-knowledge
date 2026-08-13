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
 * open-knowledge` so the dir name is unchanged. Seed-if-absent: a host whose
 * `SKILL.md` already exists is left untouched; when `createIfWired` is set
 * (managed-project opens only), CREATE the skill for any host whose project MCP
 * config already carries the OK marker but has none. This heals the cohort of
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
import { resolveBundleEnabled, USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import { classifyInstallShape } from './install-shape.ts';

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
 * OK project.
 *
 * Version-INDEPENDENT family prefix of the CLI's `CHAIN_VERSION_SENTINEL` /
 * `CHAIN_WIN_VERSION_SENTINEL` (both in `editors.ts`, `@internal` and
 * deliberately not re-exported — hence this local copy). "Wired at all" must
 * survive a sentinel bump: a project wired under `# ok-mcp-v1` is still wired
 * after the chain moves to `v2` (the entry upgrades lazily via the repair
 * sweep), and `# ok-mcp-win-…` shares the prefix, so one marker covers both
 * platforms and every version. Same shape as `OK_MCP_MARKER_PREFIX` in
 * `worktree-setup-inherit.ts`.
 */
const OK_MCP_MARKER = '# ok-mcp-';

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
  // Sweep each install host PLUS `.agents` (the central store's parent /
  // codex's former home) PLUS the hosts the external `skills` CLI's
  // `--agent '*'` fanned to that were never OK install targets — a survivor
  // in ANY user root now lists as a phantom global skill (the in-place scan
  // no longer name-filters built-ins; `.pi/agent/skills` shipped one).
  const legacyHostDirs = [
    ...HOSTS_WITH_USER_SKILL_DIR.map((h) => h.hostDir),
    '.agents',
    '.pi/agent',
    '.copilot',
    '.gemini',
  ];
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
  | {
      kind: 'central';
      path: string;
      status: 'written' | 'skipped-present' | 'failed';
      error?: string;
    }
  | {
      kind: 'host';
      hostDir: string;
      editorId: string;
      path: string;
      status: 'written' | 'skipped-present' | 'skipped-host-absent' | 'failed';
      error?: string;
    };

type UserSkillReclaimResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; version: string; entries: UserSkillReclaimEntry[] };

interface ReclaimUserSkillsOpts {
  home: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  /** `app.getPath('exe')` — must match a supported packaged layout (`install-shape.ts`). */
  executablePath: string;
  /** Env for install-shape classification (AppImage detection). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
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
    /**
     * Count a genuine install on skills.sh (server `reportSkillInstall` +
     * `resolveSkillInstallReportSettings`, wired by the caller so this module
     * stays free of server imports). Called ONLY for bundles this pass actually
     * wrote: the reclaim is seed-if-absent, so `skipped-present` is not an
     * install and must not be reported. Optional — omitted in tests.
     */
    reportInstalled?(skillNames: readonly string[], scope?: string): void;
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
 * entries plus this bundle's own `anyWritten` / `anyDestinationSucceeded`
 * flags. Looped over `deps.userGlobalBundles` so discovery + write-skill both
 * land.
 *
 * Both flags are PER BUNDLE by construction: the version-advance gate and the
 * outcome event must not read them off a pooled entry list, or one bundle's
 * success answers for a sibling that landed nowhere. Sibling of the CLI's
 * `installUserBundleToHostDirs` in `packages/cli/src/commands/repair-skills.ts`
 * — keep the shape aligned.
 */
function installUserBundleToHostDirs(
  home: string,
  bundleDirName: string,
  sourceDir: string,
  fs: SkillFsOps,
  logger: SkillReclaimLogger,
  version: string,
): { entries: UserSkillReclaimEntry[]; anyWritten: boolean; anyDestinationSucceeded: boolean } {
  const entries: UserSkillReclaimEntry[] = [];
  const centralDest = join(home, '.agents', 'skills', bundleDirName);
  // SEED-IF-ABSENT: the reclaim guarantees the
  // built-in is PRESENT (offline-safe), but never OVERWRITES an existing copy —
  // that copy may be a user-applied skills.sh update, and force-refreshing it
  // would clobber the update + churn a version string every launch. Updates now
  // flow through the manual "update available" path, not this launch hook.
  const centralRootExists = fs.existsSync(join(home, '.agents'));
  if (centralRootExists && fs.existsSync(centralDest)) {
    entries.push({ kind: 'central', path: centralDest, status: 'skipped-present' });
  } else if (centralRootExists) {
    try {
      replaceDir(sourceDir, centralDest, fs);
      entries.push({ kind: 'central', path: centralDest, status: 'written' });
      logger.event({
        event: 'user-skill-reclaim-central-written',
        path: centralDest,
        preexisting: false,
        version,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      entries.push({ kind: 'central', path: centralDest, status: 'failed', error });
      logger.event({ event: 'user-skill-reclaim-central-failed', path: centralDest, error });
    }
  }

  for (const host of USER_SKILL_HOSTS) {
    const hostRoot = join(home, host.hostDir);
    const hostDest = join(home, host.skillsRoot, bundleDirName);
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
    // Seed-if-absent per host too: an existing host copy is left as-is (it may
    // be a user-applied update or a symlink they chose).
    if (fs.existsSync(hostDest)) {
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'skipped-present',
      });
      continue;
    }
    try {
      replaceDir(sourceDir, hostDest, fs);
      entries.push({
        kind: 'host',
        hostDir: host.hostDir,
        editorId: host.editorId,
        path: hostDest,
        status: 'written',
      });
      logger.event({
        event: 'user-skill-reclaim-host-written',
        editorId: host.editorId,
        path: hostDest,
        preexisting: false,
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
  return {
    entries,
    anyWritten: entries.some((entry) => entry.status === 'written'),
    anyDestinationSucceeded: entries.some(
      (entry) => entry.status === 'written' || entry.status === 'skipped-present',
    ),
  };
}

function userBundleExists(home: string, bundleName: string, fs: SkillFsOps): boolean {
  return (
    fs.existsSync(join(home, '.agents', 'skills', bundleName)) ||
    USER_SKILL_HOSTS.some((host) => fs.existsSync(join(home, host.skillsRoot, bundleName)))
  );
}

/**
 * SEED-IF-ABSENT the bundled SKILL into the user-level central store and into
 * every detected per-host directory: write ONLY when the destination dir is
 * absent, never overwrite an existing (possibly user-updated) copy. Updates to
 * the built-ins flow through the normal skills.sh "update available" path, not
 * this launch hook. Records progress to `~/.ok/skill-state.yml` and the JSONL
 * event log even on partial failure.
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
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  // Supported packaged layouts only (darwin bundle / NSIS / linux dir —
  // install-shape.ts). AppImage declines: its ephemeral mount path must
  // never be persisted into user or project config.
  const installShape = classifyInstallShape(platform, executablePath, opts.env ?? process.env);
  if (installShape.kind === 'appimage') {
    return { status: 'skipped', reason: 'appimage-ephemeral' };
  }
  if (installShape.kind === 'unsupported') {
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
    const onDisk = userBundleExists(home, bundle.name, fs);
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

  // Seed each enabled user-global bundle (discovery + write-skill) into the
  // central store + per-host dirs (if-absent), each under its own name.
  const entries: UserSkillReclaimEntry[] = [];
  // Bundles this pass actually WROTE. The reclaim is seed-if-absent, so on
  // every launch after the first each bundle reads `skipped-present` — that is
  // not an install and reporting it would turn an install counter into a launch
  // counter. Collected per bundle because the entry rows do not carry a name.
  const installedBundleNames: string[] = [];
  // Per-bundle outcome flags. Read off the pooled `entries` list instead, one
  // bundle's success answers for a sibling whose only write threw, and that
  // sibling then reports `installed`. Mirrors the CLI sweep's `bundleResults`.
  const bundleResults: Array<{ id: string; landed: boolean; failed: boolean }> = [];
  for (const bundle of gatedBundles) {
    const result = installUserBundleToHostDirs(
      home,
      bundle.name,
      bundle.sourceDir,
      fs,
      logger,
      version,
    );
    if (result.anyWritten) installedBundleNames.push(bundle.name);
    entries.push(...result.entries);
    bundleResults.push({
      id: bundle.id,
      landed: result.anyDestinationSucceeded,
      failed: result.entries.some((e) => e.status === 'failed'),
    });
  }
  // Machine-scoped, matching the CLI's user-global install: these bundles live
  // once per machine, so a second project must not re-count them.
  if (installedBundleNames.length > 0) deps.reportInstalled?.(installedBundleNames);

  const anyWriteSucceeded = installedBundleNames.length > 0;
  // Every gated bundle has to have reached a destination of its own before the
  // shared state file may advance — otherwise the failing bundle rides its
  // sibling's success into an `installed` event.
  const allBundlesLanded = bundleResults.every((b) => b.landed);
  if (anyWriteSucceeded && allBundlesLanded) {
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
    // One event per bundle that actually threw, naming the bundle: a pooled
    // event would let a sibling's success hide it. A bundle that landed gets no
    // event — the state file was not advanced, so nothing may claim it was.
    for (const { id, failed } of bundleResults) {
      if (!failed) continue;
      await deps
        .recordSkillInstallEvent({
          ts: nowDate().toISOString(),
          surface: 'desktop-direct',
          target: 'cli-hosts',
          bundle: id,
          outcome: 'failed',
          version,
          reason: 'all-targets-failed',
        })
        .catch(() => {});
    }
  }
  // Seed-if-absent no-op — every target already present — falls through the
  // loop above with nothing written and nothing failed: no state advance and
  // no outcome event.

  return { status: 'done', version, entries };
}

// ---------------------------------------------------------------------------
// Project-level reclaim
// ---------------------------------------------------------------------------

type ProjectSkillReclaimEntry = {
  editorId: string;
  hostDir: string;
  path: string;
  status: 'no-token' | 'present' | 'created' | 'failed';
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
  /** Env for install-shape classification (AppImage detection). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
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
    /**
     * Count a genuine install on skills.sh. Called only for hosts this pass
     * CREATED the project skill for — opening a project that already has it is
     * not an install. Scoped to the project so a second project counts and
     * reopening the same one does not. Optional — omitted in tests.
     */
    reportInstalled?(skillNames: readonly string[], scope?: string): void;
    /**
     * The user's recorded choice for THIS project's skill: `false` when they
     * switched it off in Settings, `true` when they switched it on, `null` when
     * they never said. Only an explicit `false` suppresses creation — `null`
     * still heals the pre-writer cohort, which is what `createIfWired` is for.
     * Optional — omitted in tests (reads as "no recorded decision").
     */
    readProjectSkillDecision?(projectDir: string): Promise<boolean | null>;
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
    return bytes.includes(OK_MCP_MARKER);
  } catch {
    return false;
  }
}

/**
 * Project-scope SKILL reclaim, SEED-IF-ABSENT. Per-host gate: write
 * `<projectDir>/.<host>/skills/open-knowledge/` ONLY when `SKILL.md` is absent
 * AND — with `createIfWired` set — that editor's project MCP config carries
 * `OK_MCP_MARKER` (create; heals the managed MCP-but-no-skill cohort). An
 * existing project skill is left untouched (updates flow through the manual
 * skills.sh path, so a pulled/shared project never silently changes). Without
 * `createIfWired` this stays no-create: greenfield / non-OK folders get nothing.
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
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  // Supported packaged layouts only (darwin bundle / NSIS / linux dir —
  // install-shape.ts). AppImage declines: its ephemeral mount path must
  // never be persisted into user or project config.
  const installShape = classifyInstallShape(platform, executablePath, opts.env ?? process.env);
  if (installShape.kind === 'appimage') {
    return { status: 'skipped', reason: 'appimage-ephemeral' };
  }
  if (installShape.kind === 'unsupported') {
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

  // An explicit OFF in Settings outranks `createIfWired`. Without this the
  // toggle is a lie: the user switches the project skill off, and the very next
  // open recreates it for every wired host. `null` (never asked) still heals the
  // cohort onboarded before the project-skill writer existed.
  const skillDecision =
    (await deps.readProjectSkillDecision?.(projectDir).catch(() => null)) ?? null;
  if (skillDecision === false) {
    logger.event({ event: 'project-skill-reclaim-declined-by-user', projectDir });
    return { status: 'skipped', reason: 'declined-by-user' };
  }

  const entries: ProjectSkillReclaimEntry[] = [];
  for (const host of HOSTS_WITH_USER_SKILL_DIR) {
    const dest = join(projectDir, host.hostDir, 'skills', PROJECT_SKILL_DIR_NAME);
    const skillFile = join(dest, 'SKILL.md');
    const skillExists = fs.existsSync(skillFile);
    if (skillExists) {
      // Seed-if-absent: an existing project skill is left untouched.
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status: 'present',
      });
      continue;
    }
    // Create only when explicitly enabled AND the editor is OK-wired for this
    // project. The config path comes from `EDITOR_TARGETS` (single source of
    // truth).
    const projectConfigPath = EDITOR_TARGETS[host.editorId]?.projectConfigPath?.(projectDir);
    const wired = createIfWired && editorWiredForOk(projectConfigPath, fs);
    if (!wired) {
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
      // route the recursive removal + copy through the symlink target.
      assertProjectPathSafe(dest, projectDir);
      replaceDir(sourceDir, dest, fs);
      entries.push({
        editorId: host.editorId,
        hostDir: host.hostDir,
        path: dest,
        status: 'created',
      });
      logger.event({
        event: 'project-skill-reclaim-created',
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

  // Opening a wired project that has no project skill CREATES it — a real
  // install of a skill we publish, and the case that made desktop counts look
  // flat. Only `created` counts: a project that already had the skill is
  // reopened constantly and reports nothing. Scoped to the project so a second
  // project counts and reopening the same one does not.
  if (entries.some((e) => e.status === 'created')) {
    deps.reportInstalled?.([PROJECT_SKILL_DIR_NAME], projectDir);
  }

  return { status: 'done', entries };
}
