import { externalSkillFileLiveDocName } from '@inkeep/open-knowledge-core';
import { useDocumentContext } from '@/editor/DocumentContext';
import { hashFromDocName, replaceHashWithoutNavigation } from '@/lib/doc-hash';
import { editExternalSkill } from '@/lib/skills-api';

export function useOpenSkillForEdit(): (
  name: string,
  home: string,
  opts?: { replaceActive?: boolean; rel?: string },
) => Promise<{ ok: true; docName: string } | { ok: false; error: string }> {
  const { openTarget } = useDocumentContext();
  return async (name, home, opts) => {
    const res = await editExternalSkill({ name, home });
    if (!res.ok) return res;
    const docName = opts?.rel ? externalSkillFileLiveDocName(name, opts.rel) : res.docName;
    openTarget(
      { kind: 'doc', target: docName, docName },
      opts?.replaceActive ? { tabBehavior: 'replace-active' } : undefined,
    );
    replaceHashWithoutNavigation(hashFromDocName(docName));
    return { ok: true, docName };
  };
}
