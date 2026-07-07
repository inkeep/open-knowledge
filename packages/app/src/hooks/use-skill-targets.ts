import {
  type SkillTargetEditor,
  type SkillTargetsGetSuccess,
  SkillTargetsGetSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { emitSkillsChanged } from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';
import type { AsyncState } from './use-folder-config';

export interface SkillTargetsHandle {
  state: AsyncState<SkillTargetsGetSuccess>;
  /**
   * Persist a new target set via `PUT /api/skill-targets`. Re-projects every
   * managed skill server-side; on success the local target snapshot refreshes
   * and `skills-changed` fires so the skills list re-fetches its install hosts.
   * Rejects with a message on failure so the caller can surface it + roll back
   * optimistic UI.
   */
  save: (targets: SkillTargetEditor[]) => Promise<void>;
  /** True while a `save` PUT is in flight. */
  saving: boolean;
}

/**
 * The project's editable skill-target set (`.ok/skill-targets.json`): which
 * editors OK projects skills into. `GET` reads the effective set (`configured`
 * distinguishes an explicit committed set from one detected from the project's
 * configured editors). `save` writes a new set and triggers a re-projection.
 */
export function useSkillTargets(): SkillTargetsHandle {
  const [state, setState] = useState<AsyncState<SkillTargetsGetSuccess>>({ status: 'idle' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [saving, setSaving] = useState(false);

  // `refreshKey` is intentionally listed in the dep array even though it's
  // not read inside the effect body — incrementing it after a successful
  // `save` is the mechanism that re-fetches the committed set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch trigger is the only purpose of refreshKey
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch('/api/skill-targets')
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as unknown;
          throw new Error(parseApiError(body) ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<unknown>;
      })
      .then((payload) => {
        if (cancelled) return;
        const parsed = SkillTargetsGetSuccessSchema.safeParse(payload);
        if (!parsed.success) {
          console.error(
            '[ok-skills] /api/skill-targets response failed schema validation:',
            parsed.error.issues,
          );
          setState({
            status: 'error',
            message: 'Server returned an incomplete skill-targets response.',
          });
          return;
        }
        setState({ status: 'ready', data: parsed.data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const save = async (targets: SkillTargetEditor[]): Promise<void> => {
    setSaving(true);
    // No try/catch: the React Compiler can't lower a try without a catch, nor a
    // throw inside try/catch. So tolerate fetch rejection with `.catch`, reset
    // `saving` explicitly on each exit, and throw at function scope (which the
    // compiler handles) for the caller to surface.
    const res = await fetch('/api/skill-targets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets }),
    }).catch(() => null);
    if (!res?.ok) {
      setSaving(false);
      const body = res ? ((await res.json().catch(() => null)) as unknown) : null;
      throw new Error(parseApiError(body) ?? (res ? `HTTP ${res.status}` : 'Request failed'));
    }
    // Re-projection changed which hosts every managed skill lives in: fan the
    // list re-fetch out, and refresh this snapshot so `configured` flips to true
    // and the checkboxes reflect the committed set.
    emitSkillsChanged();
    setRefreshKey((k) => k + 1);
    setSaving(false);
  };

  return { state, save, saving };
}
