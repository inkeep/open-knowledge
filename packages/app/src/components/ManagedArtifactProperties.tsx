import type { HocuspocusProvider } from '@hocuspocus/provider';
import { parseManagedArtifactName, type SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { SkillProperties } from '@/components/SkillProperties';
import { TemplateProperties } from '@/components/TemplateProperties';
import { useDocumentContext } from '@/editor/DocumentContext';
import { moveTemplate } from '@/lib/folder-config-api';
import {
  parseProjectSkillContentDocName,
  projectSkillContentDocName,
  skillLiveDocName,
  templateDocName,
} from '@/lib/managed-artifact-doc-name';
import { openManagedArtifactTab } from '@/lib/open-managed-artifact-tab';
import { useSkillScopeLabels } from '@/lib/skill-scope';
import { moveSkill, moveSkillScope } from '@/lib/skills-api';

/**
 * The identity/frontmatter panel for a managed-artifact tab (skill or template),
 * rendered by `EditorActivityPool` in place of the document `PropertyPanel`. The
 * frontmatter fields (description / title) bind live to the same provider the
 * body editor edits — so editing a managed artifact IS editing a document. The
 * `name` (and a skill's `scope`) are identity, not free-form frontmatter:
 * committing them relocates the artifact on disk (`git mv`) and re-points the
 * open tab to the new doc name.
 */
export function ManagedArtifactProperties({
  docName,
  provider,
}: {
  docName: string;
  provider: HocuspocusProvider;
}) {
  const parsed = parseManagedArtifactName(docName);
  if (parsed?.kind === 'skill') {
    return (
      <SkillPropertiesPanel
        provider={provider}
        docName={docName}
        scope={parsed.scope}
        name={parsed.name}
      />
    );
  }
  if (parsed?.kind === 'template') {
    return (
      <TemplatePropertiesPanel
        provider={provider}
        docName={docName}
        folder={parsed.folder}
        name={parsed.name}
      />
    );
  }
  // Project skills open as content docs (`.ok/skills/<name>/SKILL`) rather than
  // `__skill__/project/...`, but render the SAME identity panel as global
  // skills so the two scopes aren't a disconnected experience.
  const projectSkillName = parseProjectSkillContentDocName(docName);
  if (projectSkillName) {
    return (
      <ProjectSkillPropertiesPanel provider={provider} docName={docName} name={projectSkillName} />
    );
  }
  return null;
}

/**
 * Re-point the open tab from one managed-artifact doc name to another after a
 * rename / scope move. Opens the relocated doc (which becomes active) before
 * closing the old tab, so there's no flash of empty editor in between.
 */
function useManagedArtifactRetarget(): (fromDocName: string, toDocName: string) => void {
  const { closeDocument } = useDocumentContext();
  return (fromDocName, toDocName) => {
    if (fromDocName === toDocName) return;
    // Navigate to the relocated doc via the hash (activates it + keeps the hash
    // consistent), then drop the now-stale old tab.
    openManagedArtifactTab(toDocName);
    closeDocument(fromDocName);
  };
}

function SkillPropertiesPanel({
  provider,
  docName,
  scope,
  name,
}: {
  provider: HocuspocusProvider;
  docName: string;
  scope: SkillScope;
  name: string;
}) {
  const { t } = useLingui();
  const scopeLabels = useSkillScopeLabels();
  const retarget = useManagedArtifactRetarget();
  const [renameError, setRenameError] = useState<string | null>(null);
  const [movingScope, setMovingScope] = useState(false);

  async function handleRename(next: string) {
    setRenameError(null);
    const result = await moveSkill({ scope, fromName: name, toName: next });
    if (!result.ok) {
      setRenameError(result.error);
      toast.error(t`Couldn't rename skill: ${result.error}`);
      return;
    }
    toast.success(t`Skill renamed`);
    // Route to the renamed skill's LIVE doc — a project skill is a content doc
    // (`.ok/skills/<name>/SKILL`), not `__skill__/project/<name>`. `skillLiveDocName`
    // maps each scope to its real doc; a bare synthetic builder would open a
    // phantom empty tab for a project skill (the round-trip data-loss class).
    retarget(docName, skillLiveDocName(scope, next));
  }

  async function handleScopeChange(next: SkillScope) {
    if (next === scope || movingScope) return;
    setMovingScope(true);
    const result = await moveSkillScope({ name, fromScope: scope, toScope: next });
    setMovingScope(false);
    if (!result.ok) {
      toast.error(t`Couldn't move skill: ${result.error}`);
      return;
    }
    const skipped = result.skippedBinaryFiles?.length ?? 0;
    if (skipped > 0) {
      toast.warning(
        t`Moved "${name}" to ${scopeLabels[next]} (${skipped} binary file(s) not copied)`,
      );
    } else {
      toast.success(t`Moved "${name}" to ${scopeLabels[next]}`);
    }
    // Route to the destination scope's LIVE doc — a project skill is a content
    // doc, not `__skill__/project/<name>`. Bare `skillDocName` here opened a
    // phantom empty tab and was half of the round-trip data-loss bug.
    retarget(docName, skillLiveDocName(next, name));
  }

  return (
    <SkillProperties
      provider={provider}
      name={name}
      onRename={handleRename}
      nameError={renameError}
      nameEditable={!movingScope}
      scopeControl={{ scope, onScopeChange: handleScopeChange }}
    />
  );
}

/**
 * Identity panel for a PROJECT skill — same `SkillProperties` UI as global
 * skills, but the doc is a content doc (`.ok/skills/<name>/SKILL`), so a rename
 * retargets to the renamed content doc and a scope move to global retargets to
 * the managed-artifact tab.
 */
function ProjectSkillPropertiesPanel({
  provider,
  docName,
  name,
}: {
  provider: HocuspocusProvider;
  docName: string;
  name: string;
}) {
  const { t } = useLingui();
  const scopeLabels = useSkillScopeLabels();
  const retarget = useManagedArtifactRetarget();
  const [renameError, setRenameError] = useState<string | null>(null);
  const [movingScope, setMovingScope] = useState(false);

  async function handleRename(next: string) {
    setRenameError(null);
    const result = await moveSkill({ scope: 'project', fromName: name, toName: next });
    if (!result.ok) {
      setRenameError(result.error);
      toast.error(t`Couldn't rename skill: ${result.error}`);
      return;
    }
    toast.success(t`Skill renamed`);
    retarget(docName, projectSkillContentDocName(next));
  }

  async function handleScopeChange(next: SkillScope) {
    if (next === 'project' || movingScope) return;
    setMovingScope(true);
    const result = await moveSkillScope({ name, fromScope: 'project', toScope: next });
    setMovingScope(false);
    if (!result.ok) {
      toast.error(t`Couldn't move skill: ${result.error}`);
      return;
    }
    const skipped = result.skippedBinaryFiles?.length ?? 0;
    if (skipped > 0) {
      toast.warning(
        t`Moved "${name}" to ${scopeLabels[next]} (${skipped} binary file(s) not copied)`,
      );
    } else {
      toast.success(t`Moved "${name}" to ${scopeLabels[next]}`);
    }
    // Route to the destination scope's LIVE doc (global → managed-artifact).
    retarget(docName, skillLiveDocName(next, name));
  }

  return (
    <SkillProperties
      provider={provider}
      name={name}
      onRename={handleRename}
      nameError={renameError}
      nameEditable={!movingScope}
      scopeControl={{ scope: 'project', onScopeChange: handleScopeChange }}
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
    retarget(docName, templateDocName(folder, next));
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
