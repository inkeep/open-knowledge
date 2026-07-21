/**
 * One-time upgrade migration for Desktop-off-by-default.
 *
 * Desktop hand-offs are now opt-in (`isDesktopTargetEnabled` defaults off). Before
 * this feature the launcher showed every INSTALLED desktop app automatically, so
 * a user who was already launching Claude Desktop / Cursor / … would see those
 * rows silently disappear on upgrade. This migration preserves their experience:
 * on the first run of this version, for a user who had used the OK agent launcher
 * before, it enables every desktop target the install probe reports installed —
 * reproducing the pre-feature launcher. Fresh installs (no prior launcher state)
 * are skipped, so off-by-default still holds for brand-new users.
 *
 * Additive only: it writes enable overrides for installed targets and never
 * disables anything. Idempotent via a localStorage flag.
 *
 * Edge: a user who only ever launched a desktop app from the file-tree
 * right-click submenu (never a composer, so no sticky/preferred pick was saved)
 * reads as a fresh install and won't be migrated — they re-enable in Settings.
 */

import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { useEffect } from 'react';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { desktopEnabledKey, setAgentEnabled } from './enabled-agents';

const MIGRATION_FLAG_KEY = 'ok-acp-desktop-migration-v1';

/**
 * Launcher-pick keys that predate this feature. Their presence means this
 * machine used the OK agent launcher before Desktop went opt-in, so its
 * installed desktop apps should carry over. A fresh install has none of them.
 */
const PRIOR_LAUNCHER_KEYS: readonly string[] = [
  'ok-preferred-agent-v1', // create composer's last desktop pick
  'ok-ask-ai-agent-v2', // unified sticky pick
  'ok-ask-ai-default-agent-v1', // legacy bottom-composer default
];

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function markMigrated(): void {
  try {
    localStorage.setItem(MIGRATION_FLAG_KEY, '1');
  } catch {
    // Non-fatal — a probe-less session just retries next launch.
  }
}

/** True when this machine used the OK agent launcher before this feature. */
export function isExistingLauncherUser(): boolean {
  return PRIOR_LAUNCHER_KEYS.some((k) => readKey(k) !== null);
}

/**
 * The desktop targets to enable on migration: those the probe reports installed.
 * Returns `null` until EVERY target has a definite true/false, so the caller
 * waits rather than marking migrated prematurely. The migration is one-shot, so
 * committing on a partially-resolved probe would permanently skip any target
 * whose state hadn't landed yet.
 */
export function desktopTargetsToMigrate(
  states: Record<string, InstallState | undefined>,
): readonly HandoffTarget[] | null {
  const resolved = VISIBLE_TARGETS.every((t) => states[t.id]?.installed != null);
  if (!resolved) return null;
  return VISIBLE_TARGETS.filter((t) => states[t.id]?.installed === true).map((t) => t.id);
}

/**
 * Run the migration once. Mount on the desktop host with the live install
 * `states` from `useInstalledAgents`. Self-gates on the localStorage flag and
 * waits for the probe to resolve before acting; the effect re-runs as `states`
 * settles.
 */
export function useMigrateInstalledDesktopAgentsOnce(
  states: Record<string, InstallState | undefined>,
): void {
  useEffect(() => {
    if (readKey(MIGRATION_FLAG_KEY) !== null) return;
    // Fresh install → nothing to carry over; mark done so a brand-new user never
    // gets desktop apps auto-enabled.
    if (!isExistingLauncherUser()) {
      markMigrated();
      return;
    }
    const targets = desktopTargetsToMigrate(states);
    if (targets === null) return; // probe not resolved yet — wait for the next update
    for (const id of targets) {
      setAgentEnabled(desktopEnabledKey(id), true);
    }
    markMigrated();
  }, [states]);
}
