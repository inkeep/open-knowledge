import {
  type SkillFolderLinkPreview,
  type SkillScope,
  type SkillTargetsGetSuccess,
  SkillTargetsGetSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { useEffect, useState } from 'react';
import { emitSkillsChanged } from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';
import { putSkillFolderAction } from '@/lib/skills-api';
import type { AsyncState } from './use-folder-config';

export interface SkillTargetsHandle {
  state: AsyncState<SkillTargetsGetSuccess>;
  /** True while a folder-verb PUT is in flight. */
  saving: boolean;
  /** Folder-level verb: LINK a host's skills folder into a root (merge-then-
   *  swap; conflicts reject with a message) or UNLINK it back into per-skill
   *  symlinks. Refreshes the snapshot + skills list on success. `preview`
   *  classifies a LINK and resolves with the plan instead — nothing is written,
   *  so nothing is refreshed. */
  folderAction: (action: {
    scope: SkillScope;
    root: string;
    action: 'link' | 'unlink' | 'add-root';
    target?: string;
    preview?: boolean;
  }) => Promise<SkillFolderLinkPreview | undefined>;
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
            message: t`Server returned an incomplete skill-targets response.`,
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

  const folderAction = async (action: {
    scope: SkillScope;
    root: string;
    action: 'link' | 'unlink' | 'add-root';
    target?: string;
    preview?: boolean;
  }): Promise<SkillFolderLinkPreview | undefined> => {
    setSaving(true);
    // One client for this endpoint. Two independently-written ones had drifted
    // into reporting different fields of the same error body.
    const result = await putSkillFolderAction(action);
    if (!result.ok) {
      setSaving(false);
      throw new Error(result.error);
    }
    if (action.preview) {
      setSaving(false);
      return result.preview;
    }
    emitSkillsChanged();
    setRefreshKey((k) => k + 1);
    setSaving(false);
    return undefined;
  };

  return { state, saving, folderAction };
}
