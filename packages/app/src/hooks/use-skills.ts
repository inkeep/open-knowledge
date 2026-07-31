import { type SkillsListEntry, SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import {
  applyOptimisticSkillMoves,
  subscribeToDocumentsChanged,
  subscribeToSkillsChanged,
} from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';
import type { AsyncState } from './use-folder-config';

/**
 * Project-wide flat enumeration of skills. Backed by `GET /api/skills`, which
 * walks every `<root>/.ok/skills/<name>/SKILL.md` and enriches each entry with
 * its install-state from the OF3 marker (`installed` + `hosts`). Re-fetches on
 * the `skills-changed` event bus (same-window mutations) AND the cross-client
 * CC1 `files` signal (skill mutations broadcast `files` server-side, so a
 * create/edit/delete/rename/install from ANOTHER client — e.g. the preview
 * browser vs. the desktop app — lands here live), so the list stays current
 * across windows without a reload. Backs the Settings Skills manager + sidebar.
 */
/** Last successful `/api/skills` payload, shared across hook instances so a
 *  surface mounting LATER (e.g. the editor toolbar pill on first skill open)
 *  renders the known list instantly instead of guessing while it re-fetches. */
let lastKnownSkills: readonly SkillsListEntry[] | null = null;

/** One in-flight `/api/skills` request shared across every hook instance — a
 *  mutation fires `skills-changed` + the CC1 `files` signal into N mounted
 *  instances at once; without sharing, each ran its own full server scan. */
let inFlightSkills: Promise<unknown> | null = null;
function fetchSkillsShared(): Promise<unknown> {
  inFlightSkills ??= fetch('/api/skills')
    .then(async (r) => {
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as unknown;
        throw new Error(parseApiError(body) ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<unknown>;
    })
    .finally(() => {
      inFlightSkills = null;
    });
  return inFlightSkills;
}

export function useSkills(options?: { enabled?: boolean }): AsyncState<readonly SkillsListEntry[]> {
  // `enabled: false` keeps the hook mounted (and subscribed) but skips the
  // `/api/skills` fetch — for consumers that only need the list under a
  // condition (e.g. the tab reconciler, which has nothing to do until a skill
  // tab is actually open). Avoids a redundant fetch and unrelated side effects.
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<AsyncState<readonly SkillsListEntry[]>>(() =>
    lastKnownSkills !== null ? { status: 'ready', data: lastKnownSkills } : { status: 'idle' },
  );
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    // Trailing debounce: one mutation fires BOTH the local skills-changed event
    // and the CC1 `files` signal (plus watcher echoes of the disk writes) —
    // coalesce the burst into a single refetch instead of several back-to-back.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRefreshKey((k) => k + 1), 200);
    };
    const unsubLocal = subscribeToSkillsChanged(bump);
    const unsubRemote = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) bump();
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubLocal();
      unsubRemote();
    };
  }, []);

  // `refreshKey` is intentionally listed in the dep array even though it's
  // not read inside the effect body — incrementing it is the mechanism
  // that triggers a re-fetch when the skills-changed bus fires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch trigger is the only purpose of refreshKey
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Stale-while-revalidate: only surface the loading state on the FIRST load.
    // Every skill mutation (local `skills-changed` + cross-client CC1 `files`)
    // re-runs this effect; resetting to `loading` would blank the rendered list
    // and flash empty->full on every create/edit/install/move — the visible
    // dock flicker. Keep a prior `ready` list on screen while revalidating.
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    fetchSkillsShared()
      .then((payload) => {
        if (cancelled) return;
        // Full Zod parse (same drift-loud contract as `useAllTemplates`).
        // `SkillsListEntrySchema` is `.strict()`, so server-side field drift
        // surfaces here as an error envelope rather than landing partial
        // objects in component state.
        const parsed = SkillsListSuccessSchema.safeParse(payload);
        if (!parsed.success) {
          // Surface the Zod issues to devtools so a schema regression is
          // debuggable; the user-facing message stays generic because the
          // issue paths leak server-implementation detail.
          console.error(
            '[ok-skills] /api/skills response failed schema validation:',
            parsed.error.issues,
          );
          setState({ status: 'error', message: 'Server returned an incomplete skills response.' });
          return;
        }
        lastKnownSkills = parsed.data.skills;
        setState({ status: 'ready', data: parsed.data.skills });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, enabled]);

  // Overlay pending optimistic scope-moves so a moved skill leaves its source
  // group immediately, without waiting for the (possibly slow) move to finish.
  return state.status === 'ready'
    ? { status: 'ready', data: applyOptimisticSkillMoves(state.data) }
    : state;
}
