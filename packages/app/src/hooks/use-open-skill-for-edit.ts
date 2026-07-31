import { externalSkillFileLiveDocName } from '@inkeep/open-knowledge-core';
import { useDocumentContext } from '@/editor/DocumentContext';
import { hashFromDocName, replaceHashWithoutNavigation } from '@/lib/doc-hash';
import { editExternalSkill } from '@/lib/skills-api';

/**
 * Open a DETECTED (unmanaged) skill for in-place editing — the sibling of
 * `useOpenSkill` for skills that aren't managed by OK. It registers the skill's
 * real on-disk dir with the server (`POST /api/skill/edit-external`), then opens
 * an editable tab whose autosave-out writes back to the real harness file: the
 * skill's `SKILL.md` (no `rel`) or a bundle file (`rel`, e.g. `references/x.md`).
 * No copy, no symlink, no `.ok/` — that's the Manage upgrade, not this.
 *
 * Every "edit a detected skill" surface (sidebar SKILL.md + reference-file rows)
 * routes here so the endpoint call + open + hash-sync live in ONE place. One
 * registration covers every file under the skill dir. Returns whether the open
 * succeeded so callers can surface a failure toast.
 */
export function useOpenSkillForEdit(): (
  name: string,
  home: string,
  opts?: { replaceActive?: boolean; rel?: string },
) => Promise<{ ok: true; docName: string } | { ok: false; error: string }> {
  const { openTarget } = useDocumentContext();
  return async (name, home, opts) => {
    const res = await editExternalSkill({ name, home });
    if (!res.ok) return res;
    // The endpoint registers name -> home (covering every file under the dir) and
    // returns the SKILL.md doc name; a bundle file is that skill's ext-less
    // per-file doc name under the same registration.
    const docName = opts?.rel ? externalSkillFileLiveDocName(name, opts.rel) : res.docName;
    openTarget(
      { kind: 'doc', target: docName, docName },
      opts?.replaceActive ? { tabBehavior: 'replace-active' } : undefined,
    );
    replaceHashWithoutNavigation(hashFromDocName(docName));
    return { ok: true, docName };
  };
}
