import {
  type ManagedArtifactScope,
  parseGlobalSkillBundleDoc,
  parseManagedArtifactName,
  parseProjectSkillBundleDoc,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { useEffect, useRef } from 'react';
import { useManagedArtifactRetarget } from '@/components/ManagedArtifactProperties';
import { useDocumentContext } from '@/editor/DocumentContext';
import { parseEditorTabId } from '@/editor/editor-tabs';
import {
  isOptimisticallyMoving,
  isSkillWritePending,
  pendingSkillWritesKey,
} from '@/lib/documents-events';
import { skillEntryFileLiveDocName, skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import { useSkills } from './use-skills';

const PROJECT_SKILL_COMPANION_DOC_RE = /^\.[A-Za-z0-9_-]+\/skills\/([^/]+)\/(.+)$/;

export function parseSkillTabDocName(
  docName: string,
): { scope: ManagedArtifactScope; name: string; rel: string | null } | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) return { scope: 'project', name: project.name, rel: project.rel };
  const global = parseGlobalSkillBundleDoc(docName);
  if (global) return { scope: 'global', name: global.name, rel: global.rel };
  const managed = parseManagedArtifactName(docName);
  if (managed?.kind === 'skill') {
    return { scope: managed.scope, name: managed.name, rel: managed.rel };
  }
  const companion = PROJECT_SKILL_COMPANION_DOC_RE.exec(docName);
  if (companion) {
    return { scope: 'project', name: companion[1] as string, rel: companion[2] as string };
  }
  return null;
}

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

export function tabIdsForSkillFile(
  openTabIds: ReadonlyArray<string>,
  skill: Pick<SkillsListEntry, 'scope' | 'name' | 'path' | 'canonicalPath'>,
  filePath: string,
): string[] {
  const liveDocName = skillEntryFileLiveDocName(skill, filePath);
  return openTabIds.filter((tabId) => {
    const tab = parseEditorTabId(tabId);
    if (tab.kind === 'skill-file')
      return tab.scope === skill.scope && tab.name === skill.name && tab.path === filePath;
    return tab.kind === 'doc' && tab.docName === liveDocName;
  });
}

export function skillFileForDocName(
  docName: string,
  skills: ReadonlyArray<SkillsListEntry>,
  docExt: string,
): { skill: SkillsListEntry; filePath: string } | null {
  const parsed = parseSkillTabDocName(docName);
  if (!parsed || parsed.rel === null) return null;
  const skill = skills.find((s) => s.scope === parsed.scope && s.name === parsed.name);
  if (!skill || skill.managed) return null;
  const filePath = `references/${parsed.rel}${docExt}`;
  return skillEntryFileLiveDocName(skill, filePath) === docName ? { skill, filePath } : null;
}

export type SkillTabReconcileAction =
  | { kind: 'retarget'; fromDocName: string; toDocName: string }
  | { kind: 'close'; docName: string };

export function computeSkillTabReconcile(
  openTabDocNames: ReadonlyArray<string>,
  skills: ReadonlyArray<Pick<SkillsListEntry, 'name' | 'scope' | 'path'>>,
  isBusy: (scope: ManagedArtifactScope, name: string) => boolean = (scope, name) =>
    isOptimisticallyMoving(scope, name) || isSkillWritePending(scope, name),
): SkillTabReconcileAction[] {
  const present = new Map(skills.map((s) => [`${s.scope}\u0000${s.name}`, s]));
  const actions: SkillTabReconcileAction[] = [];
  const carried = new Set<string>();
  for (const docName of openTabDocNames) {
    const tab = parseSkillTabDocName(docName);
    if (tab !== null && tab.rel === null) carried.add(`${tab.scope}\u0000${tab.name}`);
  }
  for (const docName of openTabDocNames) {
    const tab = parseSkillTabDocName(docName);
    if (!tab) continue;
    if (present.has(`${tab.scope}\u0000${tab.name}`)) continue;
    const otherScope: ManagedArtifactScope = tab.scope === 'project' ? 'global' : 'project';
    const moved = present.get(`${otherScope}\u0000${tab.name}`);
    if (tab.rel === null && moved !== undefined) {
      actions.push({
        kind: 'retarget',
        fromDocName: docName,
        toDocName: skillEntryLiveDocName(moved),
      });
    } else if (isBusy(tab.scope, tab.name)) {
    } else if (moved !== undefined && !carried.has(`${tab.scope}\u0000${tab.name}`)) {
      carried.add(`${tab.scope}\u0000${tab.name}`);
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

export function useReconcileSkillTabs(): void {
  const { openTabs, closeDocument } = useDocumentContext();
  const retarget = useManagedArtifactRetarget();
  const hasSkillTab = openTabs.some((docName) => parseSkillTabDocName(docName) !== null);
  const skillsState = useSkills({ enabled: hasSkillTab });
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (skillsState.status !== 'ready') return;
    const skills = skillsState.data;
    const signature = `${openTabs.join('\u0001')}\u0002${skills
      .map((s) => `${s.scope}\u0000${s.name}`)
      .sort()
      .join('\u0001')}\u0002${pendingSkillWritesKey()}`;
    if (lastSignatureRef.current === signature) return;
    lastSignatureRef.current = signature;

    const actions = computeSkillTabReconcile(openTabs, skills);
    for (const action of actions) {
      if (action.kind === 'retarget') {
        retarget(action.fromDocName, action.toDocName);
      } else {
        closeDocument(action.docName);
      }
    }
  }, [skillsState, openTabs, retarget, closeDocument]);
}
