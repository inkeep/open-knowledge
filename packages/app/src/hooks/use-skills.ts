import { type SkillsListEntry, SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToDocumentsChanged, subscribeToSkillsChanged } from '@/lib/documents-events';
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
export function useSkills(options?: { enabled?: boolean }): AsyncState<readonly SkillsListEntry[]> {
  // `enabled: false` keeps the hook mounted (and subscribed) but skips the
  // `/api/skills` fetch — for consumers that only need the list under a
  // condition (e.g. the tab reconciler, which has nothing to do until a skill
  // tab is actually open). Avoids a redundant fetch and unrelated side effects.
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<AsyncState<readonly SkillsListEntry[]>>({ status: 'idle' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const bump = () => setRefreshKey((k) => k + 1);
    // Local fan-out (this window made the change) + cross-client CC1 `files`
    // (another client did) — every skill mutation signals `files` server-side.
    const unsubLocal = subscribeToSkillsChanged(bump);
    const unsubRemote = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) bump();
    });
    return () => {
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
    fetch('/api/skills')
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as unknown;
          throw new Error(parseApiError(body) ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<unknown>;
      })
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

  return state;
}
