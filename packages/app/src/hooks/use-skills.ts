import { type SkillsListEntry, SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
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
 *  instances at once, and the endpoint is a synchronous walk of every editor
 *  skills root, so without sharing each one ran its own full server scan. That
 *  single-flight ceiling is load-bearing: racing N scans on the server's event
 *  loop stalls CRDT sync and the editor stops taking keystrokes. */
let inFlightSkills: Promise<unknown> | null = null;
/** A write landed while `inFlightSkills` was running, so that request predates
 *  the write and its response must not be served. Coalescing on a bare promise
 *  is what let a post-mutation refetch settle on pre-write data forever. */
let inFlightStale = false;

function invalidateSkills(): void {
  if (inFlightSkills !== null) inFlightStale = true;
}

/**
 * Invalidation is wired once, independent of any hook instance: a request can
 * outlive the last unmount (that slowness is the whole premise), and an agent
 * write landing in that window has to invalidate too, or the next mount joins
 * the pre-write request and renders a skill the user already deleted.
 *
 * Attached on first use rather than at module load, because
 * `subscribeToSkillsChanged` touches `window` — doing it at import time makes
 * merely IMPORTING this module require a DOM, which throws in the node-env unit
 * tests (and would throw under SSR) for every consumer that transitively pulls
 * it in. Lazy is still mount-independent: once attached the listeners outlive
 * every unmount, which is the window the stale-join bug lives in.
 */
let invalidationSubscribed = false;
function ensureInvalidationSubscribed(): void {
  if (invalidationSubscribed || typeof window === 'undefined') return;
  invalidationSubscribed = true;
  subscribeToSkillsChanged(invalidateSkills);
  subscribeToDocumentsChanged((channels) => {
    if (channels.includes('files')) invalidateSkills();
  });
}

/**
 * A hung request must not wedge the shared promise FOREVER.
 *
 * Every reader joins `inFlightSkills`, and the slot is only released in that
 * promise's `.finally` — so a fetch that never settles freezes the skills list
 * at its last value for the rest of the session: stale rows, a stale toolbar,
 * and clicks that mint doc names from entries that have since moved. Only a
 * reload clears it, because the slot is module state. This endpoint is a
 * synchronous walk of every skills root on the machine, so it is exactly the
 * one that can stall. Aborting turns a permanent wedge into one failed refresh
 * that the next `files` signal retries.
 */
const SKILLS_REQUEST_TIMEOUT_MS = 20_000;

function requestSkills(): Promise<unknown> {
  return fetch('/api/skills', { signal: AbortSignal.timeout(SKILLS_REQUEST_TIMEOUT_MS) }).then(
    async (r) => {
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as unknown;
        throw new Error(parseApiError(body) ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<unknown>;
    },
  );
}

/**
 * Re-run rather than race: keep exactly one scan in flight, and if a write lands
 * while it is running, throw that response away and go again. Callers therefore
 * always share ONE promise that can only resolve with post-write data — which is
 * why nothing downstream (including the shared `lastKnownSkills` seed) needs its
 * own staleness check.
 *
 * Bounded because the retry is driven by external writes: a sustained stream of
 * mutations would otherwise spin here forever. After the cap we serve what we
 * have; the next signal schedules another refetch anyway, so the list converges.
 */
const MAX_STALE_REFETCHES = 3;

function fetchSkillsShared(): Promise<unknown> {
  ensureInvalidationSubscribed();
  if (inFlightSkills !== null) return inFlightSkills;
  const pending: Promise<unknown> = (async () => {
    for (let attempt = 0; attempt < MAX_STALE_REFETCHES; attempt++) {
      inFlightStale = false;
      const data = await requestSkills();
      if (!inFlightStale) return data;
    }
    inFlightStale = false;
    return requestSkills();
  })().finally(() => {
    // `.finally` so BOTH outcomes release the slot: a rejected request (offline,
    // non-ok status) must clear it too, or every later caller would join a
    // promise that can only ever re-reject and the list would never recover.
    //
    // Identity-guarded because settle order is not start order: a superseded
    // request can resolve AFTER the one that replaced it, and an unconditional
    // reset would then null out a live newer request, so the next caller starts
    // a duplicate scan. Keep the guard on any reset added here — in particular
    // do not add a bare `.catch(() => { inFlightSkills = null; })`, which runs
    // for the same superseded requests without the identity check.
    if (inFlightSkills === pending) inFlightSkills = null;
  });
  inFlightSkills = pending;
  return pending;
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
      // Invalidation itself is wired at module scope, so it already happened
      // synchronously when the signal fired. This only paces the re-render.
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
          setState({ status: 'error', message: t`Server returned an incomplete skills response.` });
          return;
        }
        lastKnownSkills = parsed.data.skills;
        setState({ status: 'ready', data: parsed.data.skills });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Stale beats blank. A refresh that fails (offline, a 20s abort on a
        // huge skills tree) must not replace a list the user is working from
        // with an error screen — the next `files`/`skills-changed` signal
        // refetches anyway. Only a FIRST load has nothing to fall back to.
        setState((prev) =>
          prev.status === 'ready'
            ? prev
            : { status: 'error', message: err instanceof Error ? err.message : String(err) },
        );
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
