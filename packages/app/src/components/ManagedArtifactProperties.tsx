import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  isExternalSkillDocName,
  parseManagedArtifactName,
  parseTemplateContentDocName,
  type SkillScope,
  templateContentDocName,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { PropertyPanel } from '@/components/PropertyPanel';
import { SkillProperties } from '@/components/SkillProperties';
import { TemplateProperties } from '@/components/TemplateProperties';
import { useDocumentContext } from '@/editor/DocumentContext';
import { docNameForTabId } from '@/editor/editor-tabs';
import { whenSkillsListContains } from '@/hooks/use-skills';
import { hashFromDocName, replaceHashWithoutNavigation } from '@/lib/doc-hash';
import { beginSkillWrite, endSkillWrite } from '@/lib/documents-events';
import { moveTemplate } from '@/lib/folder-config-api';
import { parseProjectSkillContentDocName, skillLiveDocName } from '@/lib/managed-artifact-doc-name';
import { moveSkill } from '@/lib/skills-api';

export function ManagedArtifactProperties({
  docName,
  provider,
}: {
  docName: string;
  provider: HocuspocusProvider;
}) {
  const parsed = parseManagedArtifactName(docName);
  if (parsed?.kind === 'skill') {
    if (parsed.rel !== null) {
      return <PropertyPanel provider={provider} />;
    }
    return <SkillPropertiesPanel provider={provider} scope={parsed.scope} name={parsed.name} />;
  }
  const projectSkillName = parseProjectSkillContentDocName(docName);
  if (projectSkillName) {
    return <SkillPropertiesPanel provider={provider} scope="project" name={projectSkillName} />;
  }
  const parsedTemplate = parseTemplateContentDocName(docName);
  if (parsedTemplate) {
    return (
      <TemplatePropertiesPanel
        provider={provider}
        docName={docName}
        folder={parsedTemplate.folder}
        name={parsedTemplate.name}
      />
    );
  }
  if (isExternalSkillDocName(docName)) {
    return <PropertyPanel provider={provider} />;
  }
  return null;
}

export function useManagedArtifactRetarget(): (
  fromDocName: string,
  toDocName: string,
  opts?: {
    sourceWasActive?: boolean;
  },
) => void {
  const { openTarget, closeDocument, activeDocName, openTabs } = useDocumentContext();
  return (fromDocName, toDocName, opts) => {
    if (fromDocName === toDocName) return;
    const dest = { kind: 'doc', target: toDocName, docName: toDocName } as const;
    if (activeDocName === fromDocName || opts?.sourceWasActive === true) {
      openTarget(dest, { tabBehavior: 'replace-active' });
      replaceHashWithoutNavigation(hashFromDocName(toDocName));
    } else if (openTabs.some((id) => docNameForTabId(id) === fromDocName)) {
      openTarget(dest);
      closeDocument(fromDocName);
    }
  };
}

export function useRenameSkill(): (
  skill: { scope: SkillScope; name: string },
  next: string,
) => Promise<Awaited<ReturnType<typeof moveSkill>>> {
  const { t } = useLingui();
  const retarget = useManagedArtifactRetarget();
  const { activeDocName } = useDocumentContext();
  return async (skill, next) => {
    const sourceWasActive =
      activeDocName != null &&
      (activeDocName === skillLiveDocName(skill.scope, skill.name) ||
        (skill.scope === 'project' &&
          parseProjectSkillContentDocName(activeDocName) === skill.name));
    beginSkillWrite(skill.scope, skill.name);
    beginSkillWrite(skill.scope, next);
    let result: Awaited<ReturnType<typeof moveSkill>>;
    try {
      result = await moveSkill({ scope: skill.scope, fromName: skill.name, toName: next });
    } catch (err) {
      endSkillWrite(skill.scope, skill.name);
      endSkillWrite(skill.scope, next);
      throw err;
    }
    if (!result.ok) {
      endSkillWrite(skill.scope, skill.name);
      endSkillWrite(skill.scope, next);
      toast.error(t`Couldn't rename "${skill.name}": ${result.error}`);
      return result;
    }
    toast.success(t`Renamed to "${next}"`);
    const toDoc =
      skill.scope === 'project' && result.to !== undefined
        ? `${result.to.replace(/\/+$/, '')}/SKILL`
        : skillLiveDocName(skill.scope, next);
    const fromDoc =
      skill.scope === 'project' && result.to !== undefined
        ? `${result.to.split('/').slice(0, -1).join('/')}/${skill.name}/SKILL`
        : skillLiveDocName(skill.scope, skill.name);
    try {
      retarget(fromDoc, toDoc, { sourceWasActive });
    } catch (err) {
      console.error('[skill-rename] retarget failed after a successful rename', err);
    }
    void whenSkillsListContains(skill.scope, next).then(() => {
      endSkillWrite(skill.scope, skill.name);
      endSkillWrite(skill.scope, next);
    });
    return result;
  };
}

function SkillPropertiesPanel({
  provider,
  scope,
  name,
}: {
  provider: HocuspocusProvider;
  scope: SkillScope;
  name: string;
}) {
  const renameSkill = useRenameSkill();
  const [renameError, setRenameError] = useState<string | null>(null);

  async function handleRename(next: string) {
    setRenameError(null);
    const result = await renameSkill({ scope, name }, next);
    if (!result.ok) setRenameError(result.error);
  }

  return (
    <SkillProperties
      provider={provider}
      scope={scope}
      name={name}
      onRename={handleRename}
      nameError={renameError}
    />
  );
}

function TemplatePropertiesPanel({
  provider,
  docName,
  folder,
  name,
}: {
  provider: HocuspocusProvider;
  docName: string;
  folder: string;
  name: string;
}) {
  const { t } = useLingui();
  const retarget = useManagedArtifactRetarget();
  const [renameError, setRenameError] = useState<string | null>(null);

  async function handleRename(next: string) {
    setRenameError(null);
    const result = await moveTemplate({
      fromFolder: folder,
      fromName: name,
      toFolder: folder,
      toName: next,
    });
    if (!result.ok) {
      setRenameError(result.error);
      toast.error(t`Couldn't rename template: ${result.error}`);
      return;
    }
    toast.success(t`Template renamed`);
    retarget(docName, templateContentDocName(folder, next));
  }

  return (
    <TemplateProperties
      provider={provider}
      name={name}
      folder={folder}
      onRename={handleRename}
      nameError={renameError}
    />
  );
}
