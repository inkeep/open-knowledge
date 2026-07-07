import {
  type ManagedArtifactScope,
  parseManagedArtifactName,
  type SkillsListEntry,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';
import { useEffect, useRef } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { openManagedArtifactTab } from '@/lib/open-managed-artifact-tab';
import { useSkills } from './use-skills';

/** A skill tab's identity parsed from its live doc name (project content doc or
 *  global managed-artifact doc), or null when the doc name isn't a skill. */
export function parseSkillTabDocName(
  docName: string,
): { scope: ManagedArtifactScope; name: string } | null {
  const projectName = parseProjectSkillContentDocName(docName);
  if (projectName) return { scope: 'project', name: projectName };
  const parsed = parseManagedArtifactName(docName);
  if (parsed?.kind === 'skill') return { scope: parsed.scope, name: parsed.name };
  return null;
}

export type SkillTabReconcileAction =
  | { kind: 'retarget'; fromDocName: string; toDocName: string }
  | { kind: 'close'; docName: string };

/**
 * Pure reconcile: given the open editor tab doc names and the current skills
 * list, decide what to do with each open SKILL tab whose live doc no longer
 * corresponds to a skill at that tab's scope. A UI-driven move retargets the
 * tab itself; an agent/MCP/server-side move only broadcasts the `files` signal,
 * so an open skill tab is left pointing at a doc that no longer exists. For each
 * orphaned tab:
 *   - the same-named skill now exists at the OTHER scope (it was moved) →
 *     retarget the tab to its new live doc;
 *   - the skill is gone entirely → close the tab.
 * A tab whose skill still exists at its own scope is untouched.
 */
export function computeSkillTabReconcile(
  openTabDocNames: ReadonlyArray<string>,
  skills: ReadonlyArray<Pick<SkillsListEntry, 'name' | 'scope'>>,
): SkillTabReconcileAction[] {
  const present = new Set(skills.map((s) => `${s.scope}\u0000${s.name}`));
  const actions: SkillTabReconcileAction[] = [];
  for (const docName of openTabDocNames) {
    const tab = parseSkillTabDocName(docName);
    if (!tab) continue;
    if (present.has(`${tab.scope}\u0000${tab.name}`)) continue; // still here — leave it
    const otherScope: ManagedArtifactScope = tab.scope === 'project' ? 'global' : 'project';
    if (present.has(`${otherScope}\u0000${tab.name}`)) {
      actions.push({
        kind: 'retarget',
        fromDocName: docName,
        toDocName: skillLiveDocName(otherScope, tab.name),
      });
    } else {
      actions.push({ kind: 'close', docName });
    }
  }
  return actions;
}

/**
 * Reconcile open skill tabs against the live skills list. `useSkills` already
 * refetches on the CC1 `files` signal that every skill mutation broadcasts, so
 * an agent/MCP/server-side scope move (which never touches the client tab) lands
 * here: the moved skill's tab is retargeted to its new scope's live doc, and a
 * deleted skill's tab is closed. Mounted once under the document provider.
 */
export function useReconcileSkillTabs(): void {
  const { openTabs, closeDocument } = useDocumentContext();
  // Nothing to reconcile until a skill tab is actually open — gate the
  // `/api/skills` fetch on that, so a session with no skill tab open issues no
  // request and App-wiring stays side-effect-free, rather than fetching the
  // list eagerly on every app mount.
  const hasSkillTab = openTabs.some((docName) => parseSkillTabDocName(docName) !== null);
  const skillsState = useSkills({ enabled: hasSkillTab });
  // Guard against re-acting on a stale `skills` snapshot while a retarget's
  // own `files` refresh is in flight — only act when the input signature moves.
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (skillsState.status !== 'ready') return;
    const skills = skillsState.data;
    const signature = `${openTabs.join('\u0001')}\u0002${skills
      .map((s) => `${s.scope}\u0000${s.name}`)
      .sort()
      .join('\u0001')}`;
    if (lastSignatureRef.current === signature) return;
    lastSignatureRef.current = signature;

    const actions = computeSkillTabReconcile(openTabs, skills);
    for (const action of actions) {
      if (action.kind === 'retarget') {
        // Open the relocated doc (activates it via the hash) BEFORE closing the
        // stale tab so there's no flash of empty editor — mirrors
        // useManagedArtifactRetarget's hash-based nav.
        openManagedArtifactTab(action.toDocName);
        closeDocument(action.fromDocName);
      } else {
        closeDocument(action.docName);
      }
    }
  }, [skillsState, openTabs, closeDocument]);
}
