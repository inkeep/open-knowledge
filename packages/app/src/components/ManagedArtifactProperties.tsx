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
import { docNameForTabId, isSkillDocName } from '@/editor/editor-tabs';
import { hashFromDocName, replaceHashWithoutNavigation } from '@/lib/doc-hash';
import { moveTemplate } from '@/lib/folder-config-api';
import { parseProjectSkillContentDocName, skillLiveDocName } from '@/lib/managed-artifact-doc-name';
import { moveSkill } from '@/lib/skills-api';

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
    // Only the bare SKILL.md carries the skill's identity (name/scope = rename +
    // scope-move). A bundle FILE (`rel` set, e.g. `references/patterns`) is its own
    // content doc — show ITS frontmatter, not the parent skill's name, which read
    // as if editing it renamed/moved this file rather than the whole skill.
    if (parsed.rel !== null) {
      return <PropertyPanel provider={provider} />;
    }
    return <SkillPropertiesPanel provider={provider} scope={parsed.scope} name={parsed.name} />;
  }
  // Project skills open as content docs (`.ok/skills/<name>/SKILL`) rather than
  // `__skill__/project/...`, but render the SAME identity panel as global
  // skills so the two scopes aren't a disconnected experience.
  const projectSkillName = parseProjectSkillContentDocName(docName);
  if (projectSkillName) {
    // A project skill opens as a content doc (`<dir>/SKILL`) rather than a
    // managed-artifact doc, but its identity panel is the same one.
    return <SkillPropertiesPanel provider={provider} scope="project" name={projectSkillName} />;
  }
  // Templates are content docs (`<folder>/.ok/templates/<name>`) too, dispatched
  // on the content shape rather than a synthetic name. `name` is identity, not
  // free-form frontmatter — committing it relocates the template on disk and
  // re-points the open tab.
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
  // An editable-unmanaged skill (`__extskill__/<name>`, edited in place) is routed
  // here by `isManagedArtifactDocName`, but its frontmatter (name/description/
  // argument-hint) is free-form YAML, not OK-managed identity — there's no scope
  // move or `git mv` rename to mediate. So it gets the normal frontmatter table,
  // editable in place and binding to the same provider as the body.
  if (isExternalSkillDocName(docName)) {
    return <PropertyPanel provider={provider} />;
  }
  return null;
}

/**
 * Re-point the open tab from one managed-artifact doc name to another after a
 * rename / scope move. Opens the relocated doc (which becomes active) before
 * closing the old tab, so there's no flash of empty editor in between.
 */
export function useManagedArtifactRetarget(): (fromDocName: string, toDocName: string) => void {
  const { openTarget, closeDocument, setSkillsSidebar, activeDocName, openTabs } =
    useDocumentContext();
  return (fromDocName, toDocName) => {
    if (fromDocName === toDocName) return;
    // Pin the sidebar to Skills first: opening the new doc activates it async-ish
    // while a close synchronously nulls the active target, so for a frame
    // `skillFocused` would drop to Files. The pin bridges that frame and
    // auto-releases on the next navigation. Gated on `isSkillDocName` so a template
    // retarget (also uses this helper) is untouched.
    if (isSkillDocName(toDocName)) setSkillsSidebar(true);
    // Open the destination DIRECTLY, not via the hash → resolveNavigationTarget
    // path: a project skill content doc (`.ok/skills/<name>/SKILL`) resolves through
    // the page index, which lags a rename/scope-move by the async `files` refetch, so
    // the hash path would resolve the just-created doc to a read-only asset viewer.
    const dest = { kind: 'doc', target: toDocName, docName: toDocName } as const;
    if (activeDocName === fromDocName) {
      // The source is the ACTIVE tab (renaming/moving what you're viewing): morph it
      // in place. `replace-active` marks the old tab closed-during-restore so the
      // source doc's STILL-CONNECTED live provider can't RESURRECT it — a plain open +
      // `closeDocument` leaves that door open, so the renamed-away tab reappears and
      // strands the editor on the now-deleted doc (the three-dot / name-field rename bug).
      openTarget(dest, { tabBehavior: 'replace-active' });
      replaceHashWithoutNavigation(hashFromDocName(toDocName));
    } else if (openTabs.some((id) => docNameForTabId(id) === fromDocName)) {
      // The source is open but backgrounded: open the destination and drop the stale
      // source tab explicitly (it isn't the active tab, so replace-active can't target it).
      openTarget(dest);
      closeDocument(fromDocName);
    }
    // else: the source isn't open — nothing to retarget (the rename still happened).
  };
}

/**
 * The single rename-a-skill flow, shared by every surface that renames a skill —
 * both Properties name-field panels AND the three-dot menu's `SkillRenameDialog`.
 * One owner of: POST the move, toast the outcome, and retarget the open tab to the
 * renamed doc so the editor follows the rename instead of stranding on the (now
 * deleted) source doc. Returns the `WriteResult` so a caller can surface an inline
 * field error. Keeping this in one place is why the three surfaces can't drift
 * (the three-dot path silently skipped the retarget before this existed).
 */
export function useRenameSkill(): (
  skill: { scope: SkillScope; name: string },
  next: string,
) => Promise<Awaited<ReturnType<typeof moveSkill>>> {
  const { t } = useLingui();
  const retarget = useManagedArtifactRetarget();
  return async (skill, next) => {
    const result = await moveSkill({ scope: skill.scope, fromName: skill.name, toName: next });
    if (!result.ok) {
      toast.error(t`Couldn't rename "${skill.name}": ${result.error}`);
      return result;
    }
    toast.success(t`Renamed to "${next}"`);
    // Retarget by REAL doc names: the rename response's `to` is the renamed
    // bundle's actual dir (in-place skills keep their root; only the leaf
    // changes), so a project rename follows the real doc instead of minting a
    // phantom store-shaped `.ok/skills` tab. Global docs stay on the managed
    // `__skill__/global/` scheme.
    const toDoc =
      skill.scope === 'project' && result.to !== undefined
        ? `${result.to.replace(/\/+$/, '')}/SKILL`
        : skillLiveDocName(skill.scope, next);
    const fromDoc =
      skill.scope === 'project' && result.to !== undefined
        ? `${result.to.split('/').slice(0, -1).join('/')}/${skill.name}/SKILL`
        : skillLiveDocName(skill.scope, skill.name);
    retarget(fromDoc, toDoc);
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

  // A skill's level (scope) is edited from the editor toolbar's `SkillLevelSelect`
  // (next to the install state), not this panel — moving a skill relocates its
  // files on disk, so that control lives with the other install affordances.
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
