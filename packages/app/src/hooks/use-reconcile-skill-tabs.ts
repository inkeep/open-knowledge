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

/**
 * Companion markdown a bundle ships OUTSIDE `references/` — `<host>/skills/
 * <name>/<rel>`. The two canonical parsers admit only `SKILL` and
 * `references/**`, so without this a companion tab is invisible here and a
 * scope move or delete leaves it pointing at a doc it just removed. Anchored on
 * the same leading-dot host segment the canonical project parser uses: this
 * feeds a CLOSE decision, and a looser shape would evict an ordinary content
 * doc that merely lives under some `skills/` directory.
 */
const PROJECT_SKILL_COMPANION_DOC_RE = /^\.[A-Za-z0-9_-]+\/skills\/([^/]+)\/(.+)$/;

/**
 * A skill tab's identity parsed from its live doc name. Covers BOTH the
 * SKILL-level doc (`rel: null`) AND any bundle-FILE doc — a project content doc
 * or a global managed-artifact doc. Returns null when the doc name isn't a
 * skill or skill-file. Recognizing file tabs is what lets a bundle-editing tab
 * close when its skill is deleted.
 */
export function parseSkillTabDocName(
  docName: string,
): { scope: ManagedArtifactScope; name: string; rel: string | null } | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) return { scope: 'project', name: project.name, rel: project.rel };
  const global = parseGlobalSkillBundleDoc(docName);
  if (global) return { scope: 'global', name: global.name, rel: global.rel };
  // Managed-artifact names carry any bundle-relative `rel`, so this catches a
  // global companion (`__skill__/global/<name>/<rel>`) the strict parser drops.
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

/**
 * Return every open tab backed by ONE bundle file. A file opens either as a
 * dedicated `skill-file` tab (scripts, binaries, built-ins) or — for an
 * editable `.md`/`.mdx` reference — as an ordinary doc tab at its live doc
 * name, so a delete has to evict both shapes.
 */
export function tabIdsForSkillFile(
  openTabIds: ReadonlyArray<string>,
  // `canonicalPath` included deliberately: `skillEntryFileLiveDocName` prefers
  // it, so a caller passing a literal without it would mint alias-shaped names
  // that match no open tab and silently select nothing.
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

/**
 * Resolve an editable bundle-FILE doc tab back to its owning skill and its
 * on-disk bundle path — the inverse of `skillEntryFileLiveDocName`, which is
 * what the Skills sidebar calls to open one. Without this a `references/*.md`
 * tab carried NO skill actions at all (the skill-level map is keyed by the
 * SKILL doc), so the same file offered Rename/Delete in the sidebar and nothing
 * on its own tab.
 *
 * Live doc names are ext-less by design, so the caller supplies the extension
 * (the page index's `docExt`, `.md` when unknown). `.md` and `.mdx` strip to the
 * SAME doc name, so the round-trip below cannot tell them apart — an `.mdx`
 * reference whose extension the page index doesn't carry resolves to a path
 * that isn't on disk. Every writer reports that as a miss rather than a silent
 * success, so it surfaces as "no longer in this skill" instead of deleting the
 * wrong file.
 */
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
  // Only trust the reconstruction when it round-trips to the doc name we were
  // handed — a skill whose entry sits under a different dir than the tab's
  // would otherwise address a file in the wrong folder.
  return skillEntryFileLiveDocName(skill, filePath) === docName ? { skill, filePath } : null;
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
 *   - a bundle-FILE tab whose skill moved scope → close it, PROVIDED the skill
 *     stays open some other way. Clicking a skill and then one of its bundle
 *     files leaves the file tab as the only one for that skill (the file
 *     replaces the SKILL preview tab), and closing it outright emptied the
 *     Skills surface, which then fell back to Files — the user asked to move a
 *     skill and landed in the file tree. With no SKILL-level tab to carry them,
 *     the first such tab retargets to the new scope's SKILL doc instead.
 * A tab whose skill still exists at its own scope is untouched.
 */
export function computeSkillTabReconcile(
  openTabDocNames: ReadonlyArray<string>,
  skills: ReadonlyArray<Pick<SkillsListEntry, 'name' | 'scope' | 'path'>>,
  /** Is a write in flight for this skill? While one is, its absence from the
   *  list is not evidence of deletion, so nothing destructive may act on it. */
  isBusy: (scope: ManagedArtifactScope, name: string) => boolean = (scope, name) =>
    isOptimisticallyMoving(scope, name) || isSkillWritePending(scope, name),
): SkillTabReconcileAction[] {
  const present = new Map(skills.map((s) => [`${s.scope}\u0000${s.name}`, s]));
  const actions: SkillTabReconcileAction[] = [];
  // Skills that already have a SKILL-level tab open to carry the move, plus the
  // ones a bundle-file tab has been promoted to carry it. One promotion per
  // skill: a second retarget onto the same doc would duplicate the tab.
  const carried = new Set<string>();
  for (const docName of openTabDocNames) {
    const tab = parseSkillTabDocName(docName);
    if (tab !== null && tab.rel === null) carried.add(`${tab.scope}\u0000${tab.name}`);
  }
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
    // Pending writes belong in the signature: a guarded close is DEFERRED,
    // not cancelled, so clearing the flag must re-run this effect. Without it
    // the list is identical either side of the write, the effect short-
    // circuits, and "close once it settles" silently becomes "never" —
    // leaking dead tabs instead of closing them.
    const signature = `${openTabs.join('\u0001')}\u0002${skills
      .map((s) => `${s.scope}\u0000${s.name}`)
      .sort()
      .join('\u0001')}\u0002${pendingSkillWritesKey()}`;
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
