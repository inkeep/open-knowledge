import {
  type ManagedArtifactScope,
  parseGlobalSkillBundleDoc,
  parseProjectSkillBundleDoc,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { useEffect, useRef } from 'react';
import { useManagedArtifactRetarget } from '@/components/ManagedArtifactProperties';
import { useDocumentContext } from '@/editor/DocumentContext';
import { parseEditorTabId } from '@/editor/editor-tabs';
import { skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import { useSkills } from './use-skills';

/**
 * A skill tab's identity parsed from its live doc name. Covers BOTH the
 * SKILL-level doc (`rel: null`) AND a bundle-FILE doc (`references/<rel>`) — a
 * project content doc or a global managed-artifact doc. Returns null when the
 * doc name isn't a skill or skill-file. Recognizing file tabs is what lets a
 * reference-editing tab close when its skill is deleted.
 */
export function parseSkillTabDocName(
  docName: string,
): { scope: ManagedArtifactScope; name: string; rel: string | null } | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) return { scope: 'project', name: project.name, rel: project.rel };
  const global = parseGlobalSkillBundleDoc(docName);
  if (global) return { scope: 'global', name: global.name, rel: global.rel };
  return null;
}

/** Return every open tab backed by one skill, including bundle-file viewers. */
export function tabIdsForSkill(
  openTabIds: ReadonlyArray<string>,
  scope: ManagedArtifactScope,
  name: string,
): string[] {
  return openTabIds.filter((tabId) => {
    const tab = parseEditorTabId(tabId);
    if (tab.kind === 'skill-file') return tab.scope === scope && tab.name === name;
    if (tab.kind !== 'doc') return false;
    const skillTab = parseSkillTabDocName(tab.docName);
    return skillTab?.scope === scope && skillTab.name === name;
  });
}

export type SkillTabReconcileAction =
  | { kind: 'retarget'; fromDocName: string; toDocName: string }
  | { kind: 'close'; docName: string };

/**
 * Pure reconcile: given the open editor tab doc names and the current skills
 * list, decide what to do with each open SKILL or skill-FILE tab whose live doc
 * no longer corresponds to a skill at that tab's scope. A UI-driven move
 * retargets the SKILL tab; an agent/MCP/server-side move (or a delete) only
 * broadcasts the `files` signal, so an open tab is left pointing at a doc that
 * no longer exists. For each orphaned tab:
 *   - a SKILL-level tab whose skill moved to the OTHER scope → retarget to its
 *     new live doc (follows the move);
 *   - the skill is gone entirely (deleted) → close the tab, INCLUDING a
 *     reference-FILE tab — the lingering tab a delete used to leave;
 *   - a bundle-FILE tab whose skill moved scope → close it (its SKILL tab
 *     retargets to the new scope, so the skill stays open).
 * A tab whose skill still exists at its own scope is untouched.
 */
export function computeSkillTabReconcile(
  openTabDocNames: ReadonlyArray<string>,
  skills: ReadonlyArray<Pick<SkillsListEntry, 'name' | 'scope' | 'path'>>,
): SkillTabReconcileAction[] {
  const present = new Map(skills.map((s) => [`${s.scope}\u0000${s.name}`, s]));
  const actions: SkillTabReconcileAction[] = [];
  for (const docName of openTabDocNames) {
    const tab = parseSkillTabDocName(docName);
    if (!tab) continue;
    if (present.has(`${tab.scope}\u0000${tab.name}`)) continue; // still here — leave it
    const otherScope: ManagedArtifactScope = tab.scope === 'project' ? 'global' : 'project';
    const moved = present.get(`${otherScope}\u0000${tab.name}`);
    // Only the SKILL-level tab follows a scope move; a bundle-FILE tab can't be
    // retargeted safely (its new-scope doc name would need reconstruction), and
    // the SKILL tab already carries the user to the new scope, so it just closes.
    // Retarget to the entry's REAL doc — minting a shape here produced phantom
    // `.ok/skills` tabs for in-place skills (the store-fossil class).
    if (tab.rel === null && moved !== undefined) {
      actions.push({
        kind: 'retarget',
        fromDocName: docName,
        toDocName: skillEntryLiveDocName(moved),
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
  const retarget = useManagedArtifactRetarget();
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
        // Reuse the SHARED retarget so the safety net can't drift from the UI path:
        // it pins the sidebar to Skills, opens the relocated doc directly (never the
        // page-index-dependent hash path), and closes the source resurrection-safe.
        retarget(action.fromDocName, action.toDocName);
      } else {
        closeDocument(action.docName);
      }
    }
  }, [skillsState, openTabs, retarget, closeDocument]);
}
