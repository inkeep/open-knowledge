import { type SkillsListEntry, SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { useEffect, useState } from 'react';
import {
  applyOptimisticSkillMoves,
  subscribeToDocumentsChanged,
  subscribeToSkillsChanged,
} from '@/lib/documents-events';
import { projectSkillBundleDirs, setKnownProjectSkillDirs } from '@/lib/known-skill-dirs';
import { parseApiError } from '@/lib/parse-api-error';
import type { AsyncState } from './use-folder-config';

let lastKnownSkills: readonly SkillsListEntry[] | null = null;

let inFlightSkills: Promise<unknown> | null = null;
let inFlightStale = false;

function invalidateSkills(): void {
  if (inFlightSkills !== null) inFlightStale = true;
}

let invalidationSubscribed = false;
function ensureInvalidationSubscribed(): void {
  if (invalidationSubscribed || typeof window === 'undefined') return;
  invalidationSubscribed = true;
  subscribeToSkillsChanged(invalidateSkills);
  subscribeToDocumentsChanged((channels) => {
    if (channels.includes('files')) invalidateSkills();
  });
}

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
    if (inFlightSkills === pending) inFlightSkills = null;
  });
  inFlightSkills = pending;
  return pending;
}

export function whenSkillsListContains(
  scope: SkillsListEntry['scope'],
  name: string,
  timeoutMs = 15_000,
): Promise<void> {
  const hit = () => lastKnownSkills?.some((s) => s.scope === scope && s.name === name) === true;
  if (hit()) return Promise.resolve();
  void fetchSkillsShared().catch(() => {});
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const settle = () => {
      clearInterval(timer);
      unsub();
      resolve();
    };
    const timer = setInterval(() => {
      if (hit() || Date.now() >= deadline) settle();
    }, 250);
    const unsub = subscribeToSkillsChanged(() => {
      void fetchSkillsShared().catch(() => {});
      if (hit()) settle();
    });
  });
}

export function useSkills(options?: { enabled?: boolean }): AsyncState<readonly SkillsListEntry[]> {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<AsyncState<readonly SkillsListEntry[]>>(() =>
    lastKnownSkills !== null ? { status: 'ready', data: lastKnownSkills } : { status: 'idle' },
  );
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch trigger is the only purpose of refreshKey
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    fetchSkillsShared()
      .then((payload) => {
        if (cancelled) return;
        const parsed = SkillsListSuccessSchema.safeParse(payload);
        if (!parsed.success) {
          console.error(
            '[ok-skills] /api/skills response failed schema validation:',
            parsed.error.issues,
          );
          setState({ status: 'error', message: t`Server returned an incomplete skills response.` });
          return;
        }
        lastKnownSkills = parsed.data.skills;
        setKnownProjectSkillDirs(projectSkillBundleDirs(parsed.data.skills));
        setState({ status: 'ready', data: parsed.data.skills });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
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

  return state.status === 'ready'
    ? { status: 'ready', data: applyOptimisticSkillMoves(state.data) }
    : state;
}
