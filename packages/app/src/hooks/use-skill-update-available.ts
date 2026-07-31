import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { reimportSkill } from '@/lib/skills-api';

/**
 * Whether an imported skill's upstream source has a NEWER version than what's
 * installed — resolved by a dry-run re-import (fetch upstream + compare, no write).
 * Drives showing the "Update" action only when there's actually something to
 * update (rather than a permanent check-for-updates button).
 *
 * Runs when `enabled` (a reimportable skill) and re-runs on `name` change or when
 * `recheck()` is called (e.g. right after applying an update, so the button hides
 * again). Reusable by any skill surface that wants an "update available" signal.
 */
export function useSkillUpdateAvailable(
  scope: SkillScope,
  name: string,
  enabled: boolean,
): { available: boolean; gitTracked: boolean; recheck: () => void } {
  const [available, setAvailable] = useState(false);
  const [gitTracked, setGitTracked] = useState(false);
  // `recheck()` bumps this to re-run the effect (e.g. right after applying an
  // update, so the button re-evaluates and hides), so it MUST stay in the deps.
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run trigger is the only purpose of nonce
  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    void reimportSkill({ scope, name, dryRun: true }).then((result) => {
      // A failed check (unreachable/non-fetchable source) reads as "no update" —
      // never surface an Update button we can't honor.
      if (cancelled) return;
      setAvailable(result.ok && result.updated === true);
      setGitTracked(result.ok && result.gitTracked === true);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, name, enabled, nonce]);

  return { available, gitTracked, recheck: () => setNonce((n) => n + 1) };
}
