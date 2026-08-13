/**
 * Enumerate the user-global built-in SKILL bundle directories `ok uninstall`
 * must remove — the exact reverse of the installer's fan-out in
 * `repair-skills.ts`'s `installUserBundleToHostDirs`.
 *
 * OK force-installs its user-global bundles (`open-knowledge-discovery` +
 * `open-knowledge-write-skill`) into:
 *   - the central store  `~/.agents/skills/<name>/`, and
 *   - each concrete user-skill root, including nested Pi and Copilot layouts.
 *
 * This computes the identical set from the SAME single sources the installer
 * loops over — `USER_GLOBAL_BUNDLE_IDS`, `BUNDLE_SKILL_NAME`, and
 * `USER_SKILL_HOSTS` — so the teardown can never remove more or less
 * than what was installed (a new user-global bundle or host flows to both sides
 * automatically). Only the specific `open-knowledge-*` bundle dirs are targeted,
 * never the shared `~/.agents/skills/` root, so a user's other skills survive.
 *
 * Pure enumeration — no filesystem access. The removal engine turns each target
 * into a whole-dir removal (tolerant of an already-absent dir).
 *
 * NOT included (user content, preserved by default): `~/.ok/skills/<name>/`
 * (OK-authored global skills) and `~/Downloads/openknowledge.skill`.
 */

import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import {
  BUNDLE_SKILL_NAME,
  type BundleId,
  USER_GLOBAL_BUNDLE_IDS,
} from '@inkeep/open-knowledge-server';

/**
 * The agent homes a pre-0.42 `ok init` created skill copies in, for tools OK
 * does not support and the user very likely never installed.
 *
 * Until 0.42 the install shelled out to `npx skills … --agent '*' -g`, which
 * skipped that CLI's host detection and wrote into every host in its registry
 * (issue #820). This is the observed result of that command against a pristine
 * `$HOME`, minus the hosts OK still installs to.
 *
 * FROZEN — a historical record of what one shipped version did, not a mirror of
 * anything upstream. It can never need updating: no future OK version writes
 * these paths, and the third-party registry growing further is irrelevant
 * because no OK build will ever have fanned out to the new entries. Deletion
 * only; never an install target.
 *
 * `hostDir` is the parent of `skills/`, so nested agent homes (`.astrbot/data`,
 * `.tabnine/agent`) are expressed exactly as they were written.
 *
 * `pruneRoot` is the TOPMOST dir OK may remove once it is empty — hardcoded per
 * entry rather than derived, so pruning can only ever delete a directory whose
 * name is an agent home from this list. It is NOT always `hostDir`'s first
 * segment: the XDG entries live under the shared `~/.config`, which OK must
 * never remove even if it happens to be empty, so their root stops at the
 * tool's own folder (`.config/goose`, not `.config`).
 */
interface LegacyFanoutHost {
  /** Home-relative parent of the `skills/` dir the fan-out wrote into. */
  readonly hostDir: string;
  /** Home-relative topmost dir OK may remove when empty. */
  readonly pruneRoot: string;
}

const LEGACY_FANOUT_HOSTS: readonly LegacyFanoutHost[] = [
  { hostDir: '.adal', pruneRoot: '.adal' },
  { hostDir: '.aider-desk', pruneRoot: '.aider-desk' },
  { hostDir: '.astrbot/data', pruneRoot: '.astrbot' },
  { hostDir: '.augment', pruneRoot: '.augment' },
  { hostDir: '.autohand', pruneRoot: '.autohand' },
  { hostDir: '.bob', pruneRoot: '.bob' },
  { hostDir: '.codeartsdoer', pruneRoot: '.codeartsdoer' },
  { hostDir: '.codebuddy', pruneRoot: '.codebuddy' },
  { hostDir: '.codeium/windsurf', pruneRoot: '.codeium' },
  { hostDir: '.codemaker', pruneRoot: '.codemaker' },
  { hostDir: '.codestudio', pruneRoot: '.codestudio' },
  { hostDir: '.commandcode', pruneRoot: '.commandcode' },
  // XDG entries: stop at the tool's own folder, never at the shared `.config`.
  { hostDir: '.config/crush', pruneRoot: '.config/crush' },
  { hostDir: '.config/devin', pruneRoot: '.config/devin' },
  { hostDir: '.config/goose', pruneRoot: '.config/goose' },
  { hostDir: '.config/kimchi/harness', pruneRoot: '.config/kimchi' },
  { hostDir: '.continue', pruneRoot: '.continue' },
  { hostDir: '.factory', pruneRoot: '.factory' },
  { hostDir: '.forge', pruneRoot: '.forge' },
  { hostDir: '.grok', pruneRoot: '.grok' },
  { hostDir: '.iflow', pruneRoot: '.iflow' },
  { hostDir: '.inferencesh', pruneRoot: '.inferencesh' },
  { hostDir: '.jazz', pruneRoot: '.jazz' },
  { hostDir: '.junie', pruneRoot: '.junie' },
  { hostDir: '.kilocode', pruneRoot: '.kilocode' },
  { hostDir: '.kiro', pruneRoot: '.kiro' },
  { hostDir: '.kode', pruneRoot: '.kode' },
  { hostDir: '.lingma', pruneRoot: '.lingma' },
  { hostDir: '.mcpjam', pruneRoot: '.mcpjam' },
  { hostDir: '.moxby', pruneRoot: '.moxby' },
  { hostDir: '.mux', pruneRoot: '.mux' },
  { hostDir: '.neovate', pruneRoot: '.neovate' },
  { hostDir: '.ona', pruneRoot: '.ona' },
  { hostDir: '.openhands', pruneRoot: '.openhands' },
  { hostDir: '.pochi', pruneRoot: '.pochi' },
  { hostDir: '.qoder', pruneRoot: '.qoder' },
  { hostDir: '.qoder-cn', pruneRoot: '.qoder-cn' },
  { hostDir: '.qwen', pruneRoot: '.qwen' },
  { hostDir: '.reasonix', pruneRoot: '.reasonix' },
  { hostDir: '.roo', pruneRoot: '.roo' },
  { hostDir: '.rovodev', pruneRoot: '.rovodev' },
  { hostDir: '.snowflake/cortex', pruneRoot: '.snowflake' },
  { hostDir: '.tabnine/agent', pruneRoot: '.tabnine' },
  { hostDir: '.terramind', pruneRoot: '.terramind' },
  { hostDir: '.tinycloud', pruneRoot: '.tinycloud' },
  { hostDir: '.trae', pruneRoot: '.trae' },
  { hostDir: '.trae-cn', pruneRoot: '.trae-cn' },
  { hostDir: '.vibe', pruneRoot: '.vibe' },
  { hostDir: '.zcode', pruneRoot: '.zcode' },
  { hostDir: '.zencoder', pruneRoot: '.zencoder' },
];

/**
 * Every OK-owned skill dir name a legacy fan-out could have left behind: the
 * current user-global bundles plus the pre-split `open-knowledge` name.
 * Reserved `open-knowledge*` names OK alone writes, so removing one can never
 * touch a skill the user authored or installed themselves.
 */
const LEGACY_SWEEPABLE_SKILL_NAMES: readonly string[] = [
  ...USER_GLOBAL_BUNDLE_IDS.map((id) => BUNDLE_SKILL_NAME[id]),
  'open-knowledge',
];

export interface LegacyFanoutSweepPlan {
  /** OK's own skill dirs to delete, e.g. `~/.zencoder/skills/open-knowledge-discovery`. */
  readonly skillDirs: string[];
  /**
   * Dirs left holding nothing once `skillDirs` are gone, deepest-first. Every
   * entry is either a `skills/` dir or an agent home named in
   * `LEGACY_FANOUT_HOSTS` — never a path discovered by walking the filesystem.
   */
  readonly emptyDirs: string[];
}

/**
 * Reject a `home` that could make every path below resolve somewhere else.
 *
 * `join('', '.zencoder', …)` yields a RELATIVE path, so an empty or relative
 * home silently retargets the whole sweep at the process's cwd — which for a
 * CLI is the user's project. `'/'` would put the sweep at the filesystem root.
 * Both are programming errors, and both are unrecoverable once a delete runs,
 * so they throw rather than no-op.
 */
function assertUsableHome(home: string): string {
  if (!isAbsolute(home)) {
    throw new Error(
      `skill cleanup requires an absolute home directory; got ${JSON.stringify(home)}`,
    );
  }
  const normalized = resolve(home);
  if (normalized === sep || dirname(normalized) === normalized) {
    throw new Error(`skill cleanup refuses to operate on the filesystem root (${normalized})`);
  }
  return normalized;
}

/**
 * True when every path component from `home` down to `dir` is a real directory.
 *
 * Symlinks are followed by `existsSync` / `readdirSync` / `rmSync`, so a
 * symlinked ancestor makes the sweep act on the LINK TARGET — which may be
 * anywhere. That is not hypothetical in this ecosystem: agent hosts commonly
 * symlink their `skills/` dir at the shared `~/.agents/skills` hub, so
 * descending blind could delete a live install (or a user directory) through
 * the link. Any symlink on the path disqualifies the entry entirely: the
 * cleanup is best-effort housekeeping, and skipping is always safe.
 */
function isSymlinkFreeUnder(home: string, dir: string): boolean {
  const rel = relative(home, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  let cur = home;
  for (const segment of rel.split(sep)) {
    cur = join(cur, segment);
    try {
      // `lstat`, not `stat`: a symlink must report as a symlink, not as its target.
      if (!lstatSync(cur).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** True when `dir`'s only remaining contents are paths already slated for removal. */
function willBeEmpty(dir: string, doomed: ReadonlySet<string>): boolean {
  try {
    return readdirSync(dir).every((name) => doomed.has(join(dir, name)));
  } catch {
    // Unreadable or absent — never claim it will be empty.
    return false;
  }
}

/**
 * Compute what a legacy sweep would delete, without touching disk.
 *
 * Split from the apply step so `ok repair-skills` can show the user the exact
 * list and get consent first — this deletes from `$HOME`, and doing that
 * unannounced is the same class of overreach as the bug it cleans up.
 *
 * Pruning is bounded three ways: only dirs that are empty afterwards, only up
 * to the entry's hardcoded `pruneRoot`, and only names drawn from
 * `LEGACY_FANOUT_HOSTS`. A directory the user created that merely happens to sit
 * in the walk is never a candidate, because candidates come from the table
 * rather than from the filesystem.
 */
export function planLegacyFanoutSweep(homeInput: string): LegacyFanoutSweepPlan {
  const home = assertUsableHome(homeInput);
  const skillDirs: string[] = [];
  const emptyDirs: string[] = [];
  const doomed = new Set<string>();

  for (const entry of LEGACY_FANOUT_HOSTS) {
    const skillsDir = join(home, entry.hostDir, 'skills');
    // Refuse the whole entry if anything on the way down is a symlink.
    if (!isSymlinkFreeUnder(home, skillsDir)) continue;
    const present = LEGACY_SWEEPABLE_SKILL_NAMES.map((name) => join(skillsDir, name)).filter(
      (path) => existsSync(path),
    );
    skillDirs.push(...present);
    for (const path of present) doomed.add(path);

    // NOTE: no early-out when `present` is empty. An earlier build of this
    // cleanup removed the skill dirs WITHOUT pruning, so a machine that ran it
    // is left with empty `~/.<host>/skills/` trees and nothing to key off.
    // Gating the walk on "we deleted something just now" made those
    // permanently unreachable — the plan skipped the host and the clutter the
    // cleanup exists to remove stayed forever. The walk below is self-limiting
    // (`willBeEmpty` is false for an absent or non-empty dir), so letting it
    // run unconditionally costs one stat per host and catches that state.

    // Walk up from `skills/` to the entry's hardcoded root, stopping at the
    // first dir that would still hold something.
    const stopAt = join(home, entry.pruneRoot);
    let cur = skillsDir;
    while (willBeEmpty(cur, doomed)) {
      emptyDirs.push(cur);
      doomed.add(cur);
      if (cur === stopAt) break;
      const parent = dirname(cur);
      // Belt-and-braces: never step to or above `home`, whatever the table says.
      if (parent === cur || parent === home || !parent.startsWith(home + sep)) break;
      cur = parent;
    }
  }

  return { skillDirs, emptyDirs };
}

/**
 * True when `dir` still looks like an OK skill bundle we may remove.
 *
 * A bundle always ships a `SKILL.md`; an empty dir is also fine (nothing to
 * lose, and refusing would strand the husk forever — the same trap that made
 * the prune unreachable on already-swept machines). Anything else means the
 * path was replaced between the prompt and here, so leave it: the user was
 * shown a bundle, not whatever this now is.
 */
function isRemovableBundleDir(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    const entries = readdirSync(dir);
    return entries.length === 0 || entries.includes('SKILL.md');
  } catch {
    return false;
  }
}

/**
 * Every path the sweep is EVER allowed to delete for a given home, derived from
 * the table alone — no filesystem access, no dependence on the caller's plan.
 */
function legalSweepPaths(home: string): { skillDirs: Set<string>; emptyDirs: Set<string> } {
  const skillDirs = new Set<string>();
  const emptyDirs = new Set<string>();
  for (const entry of LEGACY_FANOUT_HOSTS) {
    const skillsDir = join(home, entry.hostDir, 'skills');
    for (const name of LEGACY_SWEEPABLE_SKILL_NAMES) skillDirs.add(join(skillsDir, name));
    const stopAt = join(home, entry.pruneRoot);
    let cur = skillsDir;
    while (true) {
      emptyDirs.add(cur);
      if (cur === stopAt) break;
      const parent = dirname(cur);
      if (parent === cur || parent === home || !parent.startsWith(home + sep)) break;
      cur = parent;
    }
  }
  return { skillDirs, emptyDirs };
}

/**
 * Execute a plan from `planLegacyFanoutSweep`. Returns the paths actually
 * removed so the caller reports real work rather than intent.
 *
 * The plan is RE-VALIDATED against `legalSweepPaths` before anything is
 * touched, and a path outside that set aborts the whole sweep without deleting
 * anything. `apply` is exported and takes plain strings, so trusting its input
 * would make any future caller — or any bug that mutates a plan between the
 * prompt and here — able to recursively delete an arbitrary directory. The
 * legal set comes from the frozen host table, so validation cannot drift from
 * what planning can produce.
 *
 * `skillDirs` are removed recursively (they hold OK's own bundle files);
 * `emptyDirs` go via `rmdir`, which refuses a non-empty directory AND refuses a
 * symlink leaf — so a race between plan and apply (the user installs the tool
 * in between) can never destroy their data. `rmdir` does NOT protect against a
 * symlinked ANCESTOR, though: the path is still resolved through the link, so
 * both legs re-check `isSymlinkFreeUnder` immediately before unlinking.
 */
export function applyLegacyFanoutSweep(homeInput: string, plan: LegacyFanoutSweepPlan): string[] {
  const home = assertUsableHome(homeInput);
  const legal = legalSweepPaths(home);

  const illegal = [
    ...plan.skillDirs.filter((p) => !legal.skillDirs.has(p)),
    ...plan.emptyDirs.filter((p) => !legal.emptyDirs.has(p)),
  ];
  if (illegal.length > 0) {
    // Loud, and BEFORE any delete: a plan that doesn't come from
    // `planLegacyFanoutSweep` is a bug, and the safe response to a bug whose
    // blast radius is `rm -rf` is to do nothing at all.
    throw new Error(
      `refusing skill cleanup — ${illegal.length} path(s) outside the known legacy set: ${illegal.join(', ')}`,
    );
  }

  const removed: string[] = [];
  for (const dir of plan.skillDirs) {
    // Re-check at delete time, not just at plan time. This is the one
    // recursive removal in the sweep, so the window between showing the user a
    // path and unlinking it is the one place a swapped symlink would cost
    // real data. `emptyDirs` below needs no equivalent — `rmdir` refuses to
    // follow a link or empty a non-empty dir on its own.
    if (!isSymlinkFreeUnder(home, dir)) continue;
    if (!isRemovableBundleDir(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Best-effort cleanup — a stubborn dir must not fail `repair-skills`,
      // whose actual job is the install.
    }
  }
  // Deepest-first: `planLegacyFanoutSweep` pushes `skills/` before its parents.
  for (const dir of plan.emptyDirs) {
    // `rmdir` refuses a symlink LEAF but still resolves a symlinked ANCESTOR,
    // so a link swapped in after planning would have it remove a directory at
    // the link target. Only ever an empty one — but "empty" is not ours to
    // assume about somewhere else on disk, so re-check the chain here.
    if (!isSymlinkFreeUnder(home, dir)) continue;
    try {
      rmdirSync(dir);
      removed.push(dir);
    } catch {
      // Non-empty (raced) or unreadable — leave it. Never force.
    }
  }
  return removed;
}

export interface SkillBundleTarget {
  /** Absolute path of the bundle directory to remove. */
  path: string;
  /** Which built-in user-global bundle this directory holds. */
  bundleId: BundleId;
  /** `central` = the shared `~/.agents/skills` store; `host` = a per-editor dir. */
  scope: 'central' | 'host';
  /** The editor host dir (e.g. `.claude`) for `host`-scope targets. */
  hostDir?: string;
}

/**
 * Every user-global built-in skill-bundle directory OK installs, for the given
 * home dir. Ordered central-first per bundle so plan output reads bundle by
 * bundle.
 */
export function userGlobalSkillBundleTargets(homeInput: string): SkillBundleTarget[] {
  // Same guard as the legacy sweep: `join('', '.agents', …)` is RELATIVE, and
  // `os.homedir()` returns `$HOME` verbatim — an empty or relative HOME would
  // aim this teardown at the process cwd. Predates the sweep, so it was missed
  // when the sweep was hardened.
  const home = assertUsableHome(homeInput);
  const targets: SkillBundleTarget[] = [];
  for (const bundleId of USER_GLOBAL_BUNDLE_IDS) {
    const name = BUNDLE_SKILL_NAME[bundleId];
    targets.push({
      path: join(home, '.agents', 'skills', name),
      bundleId,
      scope: 'central',
    });
    for (const host of USER_SKILL_HOSTS) {
      targets.push({
        path: join(home, host.skillsRoot, name),
        bundleId,
        scope: 'host',
        hostDir: host.hostDir,
      });
    }
  }
  return targets;
}

/**
 * Remove ONE user-global bundle's directories (central + every per-host copy)
 * from disk. Used by the opt-out paths (dialog decline, the Settings toggle,
 * the reclaim/sweep gate) so an unchecked bundle actually leaves — the exact
 * reverse of `installUserBundleToHostDirs`. NOT `ok init --no-skills`: that
 * flag is a per-invocation skip and removes nothing. Tolerant of already-absent dirs
 * (`rmSync` with `force`). Only the specific `open-knowledge-*` dirs, never the
 * shared `~/.agents/skills` root.
 */
export function removeUserGlobalSkillBundle(home: string, bundleId: BundleId): void {
  // Attempt EVERY path before signaling failure. `force` swallows ENOENT but
  // not EACCES/EBUSY/EIO — a throw on one host copy must not abort the rest, or
  // a declined bundle half-leaves and the next reclaim sees inconsistent state
  // across hosts. Collect failures and re-throw at the end so callers whose
  // telemetry / gate depends on it (they wrap this in try/catch and log
  // `bundle-remove-failed`) still observe a partial teardown rather than a
  // false "removed".
  const failures: Error[] = [];
  for (const target of userGlobalSkillBundleTargets(home)) {
    if (target.bundleId !== bundleId) continue;
    try {
      rmSync(target.path, { recursive: true, force: true });
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to remove ${failures.length} path(s) for ${bundleId}`,
    );
  }
}
