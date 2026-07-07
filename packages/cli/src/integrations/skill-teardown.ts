/**
 * Enumerate the user-global built-in SKILL bundle directories `ok uninstall`
 * must remove — the exact reverse of the installer's fan-out in
 * `repair-skills.ts`'s `installUserBundleToHostDirs`.
 *
 * OK force-installs its user-global bundles (`open-knowledge-discovery` +
 * `open-knowledge-write-skill`) into:
 *   - the central store  `~/.agents/skills/<name>/`, and
 *   - each per-host dir  `~/<hostDir>/skills/<name>/`  (claude / cursor / codex /
 *     opencode).
 *
 * This computes the identical set from the SAME single sources the installer
 * loops over — `USER_GLOBAL_BUNDLE_IDS`, `BUNDLE_SKILL_NAME`, and
 * `HOSTS_WITH_USER_SKILL_DIR` — so the teardown can never remove more or less
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

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUNDLE_SKILL_NAME,
  type BundleId,
  USER_GLOBAL_BUNDLE_IDS,
} from '@inkeep/open-knowledge-server';
import { HOSTS_WITH_USER_SKILL_DIR } from '../commands/editors.ts';

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
export function userGlobalSkillBundleTargets(home: string): SkillBundleTarget[] {
  const targets: SkillBundleTarget[] = [];
  for (const bundleId of USER_GLOBAL_BUNDLE_IDS) {
    const name = BUNDLE_SKILL_NAME[bundleId];
    targets.push({
      path: join(home, '.agents', 'skills', name),
      bundleId,
      scope: 'central',
    });
    for (const host of HOSTS_WITH_USER_SKILL_DIR) {
      targets.push({
        path: join(home, host.hostDir, 'skills', name),
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
 * from disk. Used by the opt-out paths (dialog decline, `ok init --no-skills`,
 * the reclaim/sweep gate) so an unchecked bundle actually leaves — the exact
 * reverse of `installUserBundleToHostDirs`. Tolerant of already-absent dirs
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
