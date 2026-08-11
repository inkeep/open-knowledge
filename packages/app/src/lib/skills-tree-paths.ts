import {
  type CatalogSkill,
  catalogRawScopeToOkScope,
  type SkillScope,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { SKILL_SCOPE_ORDER, skillDisplayName } from '@/lib/skill-scope';
import { SKILL_MD_PATH } from '@/lib/skill-sort';

/**
 * The Skills sidebar's tree-path builder: turns the managed skill list plus the
 * detected-skill catalog into the flat `<scopeLabel>/<segment>/<file>` paths the
 * Pierre tree renders, along with the prefix→skill lookups, which folders start
 * expanded, and which row is active.
 *
 * Extracted from the sidebar component because the interesting parts are pure
 * and were untestable inside it: the three-tier segment disambiguation (display
 * name → full name → host dir), the cross-tier collision guard that keeps a
 * detected skill from stealing a managed skill's row, and the empty-scope
 * sentinel that keeps a childless scope's "New / Add" menu reachable at all.
 */

// Hidden sentinel child for a scope with no skills. Pierre drops a childless
// directory from the visible tree, which makes the whole scope (and its
// New/Add menu) disappear and slides the sibling to the top. Underscores can't
// appear in a real skill name, so it can't collide.
export const EMPTY_SCOPE_SENTINEL = '__ok_empty_scope__';

// OK's own core product skills — managing them with OK is circular, so they
// never show as "Detected". Its shipped *packs* (`open-knowledge-pack-*`) are
// fair game to adopt, so they are NOT excluded.
const OK_OWN_SKILLS: ReadonlySet<string> = new Set([
  'open-knowledge',
  'open-knowledge-discovery',
  'open-knowledge-write-skill',
]);

/** Cache key for a detected skill's lazily-fetched bundle files. */
export function detectedId(s: CatalogSkill): string {
  return `${catalogRawScopeToOkScope(s.provenance.scope)}::${s.name}`;
}

export interface SkillsTreePathsInput {
  skills: readonly SkillsListEntry[];
  /** Detected (un-managed) skills; null/absent while the scan is in flight. */
  detected: readonly CatalogSkill[] | null;
  scopeLabel: Record<SkillScope, string>;
  /** Managed skills' bundle files, keyed by `rowKeyFor`. */
  filesByKey: Record<string, readonly { path: string }[]>;
  /** Detected skills' bundle-file paths, keyed by `detectedId`. */
  detectedFilesById: Record<string, readonly string[]>;
  /** Folder paths the user expanded by hand, restored across the tree's remount. */
  userExpanded: ReadonlySet<string>;
  /** Host that disambiguates two same-named skills in one scope, else undefined. */
  hostQualifierOf: (s: SkillsListEntry) => string | undefined;
  rowKeyFor: (s: SkillsListEntry) => string;
  isSkillMdActive: (s: SkillsListEntry) => boolean;
  isFileActive: (s: SkillsListEntry, filePath: string) => boolean;
  /** Is this detected skill's editable in-place buffer the open doc? */
  isDetectedActive: (s: CatalogSkill) => boolean;
}

export interface SkillsTreePaths {
  paths: string[];
  expanded: string[];
  activePath: string | undefined;
  skillByPrefix: Map<string, SkillsListEntry>;
  detectedByPrefix: Map<string, CatalogSkill>;
}

/**
 * Does an OPEN tab make this skill's doc the active one?
 *
 * "Active" drives two things: the highlighted row, and the tree's
 * row highlight. Matching `activeDocName`
 * alone gets both wrong in the same way — `activeDocName` survives on the last
 * doc tab when a non-doc target (skill-file viewer, preview) takes over, and an
 * open that never landed leaves it pointing at a doc with no tab behind it. The
 * row then reads active, and clicking it — the obvious way to retry — returns
 * before it opens anything. Requiring the tab to actually be open makes the
 * retry work, which is the one thing a user in that state will try.
 */
export function isSkillDocActive(input: {
  activeTargetKind: string | undefined;
  activeDocName: string | null;
  openTabs: readonly string[];
  docName: string;
}): boolean {
  if (input.activeTargetKind !== 'doc') return false;
  if (input.activeDocName !== input.docName) return false;
  return input.openTabs.includes(input.docName);
}

export function buildSkillsTreePaths({
  skills,
  detected,
  scopeLabel,
  filesByKey,
  detectedFilesById,
  userExpanded,
  hostQualifierOf,
  rowKeyFor,
  isSkillMdActive,
  isFileActive,
  isDetectedActive,
}: SkillsTreePathsInput): SkillsTreePaths {
  // The tree segment is normally the stripped display name, but Pierre labels
  // rows by the path basename — so when two skills in one scope strip to the
  // same name (e.g. a user `foo` beside the shipped `open-knowledge-pack-foo`)
  // a shared segment would collapse both to one row and hide one. Only the
  // colliding skills fall back to their full (unstripped) name to stay distinct.
  // Third tier: distinct-content skills that share a name outright, where even
  // the full name is identical — those take the host dir that holds them, which
  // is the thing that actually tells them apart.
  const displayCounts = new Map<string, number>();
  for (const s of skills) {
    const key = `${s.scope}\x00${skillDisplayName(s.name)}`;
    displayCounts.set(key, (displayCounts.get(key) ?? 0) + 1);
  }
  const segmentFor = (s: SkillsListEntry): string => {
    const display = skillDisplayName(s.name);
    const host = hostQualifierOf(s);
    if (host) return `${s.name} (${host === 'agents' ? '.agents' : host})`;
    return (displayCounts.get(`${s.scope}\x00${display}`) ?? 0) > 1 ? s.name : display;
  };

  const skillByPrefix = new Map<string, SkillsListEntry>();
  const paths: string[] = [];
  let activePath: string | undefined;
  // Both scope rows stay expanded. The tree remounts on any skill
  // add/remove/rename, and Pierre exposes no expansion callback to snapshot user
  // state across that — so pinning the section headers open keeps a sibling
  // scope from collapsing when an unrelated skill is deleted. Individual skill
  // folders still expand only for the active doc.
  const expanded: string[] = [];
  // Segments already taken per scope — so a detected skill can't collide with a
  // managed skill's row (or another detected skill's).
  const usedSegments = new Map<SkillScope, Set<string>>(
    SKILL_SCOPE_ORDER.map((s) => [s, new Set<string>()]),
  );
  for (const scope of SKILL_SCOPE_ORDER) {
    paths.push(`${scopeLabel[scope]}/`);
    expanded.push(`${scopeLabel[scope]}/`);
  }
  for (const s of skills) {
    const segment = segmentFor(s);
    usedSegments.get(s.scope)?.add(segment);
    const prefix = `${scopeLabel[s.scope]}/${segment}`;
    skillByPrefix.set(prefix, s);
    paths.push(`${prefix}/${SKILL_MD_PATH}`);
    if (isSkillMdActive(s)) {
      activePath = `${prefix}/${SKILL_MD_PATH}`;
      expanded.push(`${scopeLabel[s.scope]}/`, `${prefix}/`);
    }
    for (const f of filesByKey[rowKeyFor(s)] ?? []) {
      paths.push(`${prefix}/${f.path}`);
      if (!activePath && isFileActive(s, f.path)) {
        activePath = `${prefix}/${f.path}`;
        expanded.push(`${scopeLabel[s.scope]}/`, `${prefix}/`);
      }
    }
  }

  // Detected (un-managed) skills — badged rows nested under their OWN scope
  // alongside the managed ones. A detected skill's level comes from the harness
  // provenance, NOT where the file lives, so a project-scoped plugin skill lands
  // under PROJECT even though its files are in a user-global home. A detected
  // skill whose name is already OK-managed (at either scope) is skipped: the
  // managed skill is re-detected via its editor symlink, and it already shows as
  // its managed row.
  const managedNames = new Set<string>(skills.map((s) => s.name));
  const detectedByPrefix = new Map<string, CatalogSkill>();
  for (const s of detected ?? []) {
    if (managedNames.has(s.name) || OK_OWN_SKILLS.has(s.name)) continue;
    const scope = catalogRawScopeToOkScope(s.provenance.scope);
    const used = usedSegments.get(scope);
    if (!used) continue;
    let segment = skillDisplayName(s.name);
    if (used.has(segment)) segment = s.name;
    if (used.has(segment)) continue; // hard collision (rare) → don't hide a real row
    used.add(segment);
    const prefix = `${scopeLabel[scope]}/${segment}`;
    detectedByPrefix.set(prefix, s);
    paths.push(`${prefix}/${SKILL_MD_PATH}`);
    if (!activePath && isDetectedActive(s)) {
      activePath = `${prefix}/${SKILL_MD_PATH}`;
      expanded.push(`${scopeLabel[scope]}/`, `${prefix}/`);
    }
    // Once loaded, nest the detected skill's reference/script files under it and
    // keep it expanded so the tree it just revealed doesn't collapse on re-render.
    const detectedFiles = detectedFilesById[detectedId(s)] ?? [];
    for (const rel of detectedFiles) paths.push(`${prefix}/${rel}`);
    if (detectedFiles.length > 0) expanded.push(`${prefix}/`);
  }

  // Every scope with NO skills (managed or detected) gets a hidden sentinel
  // child so Pierre still renders its folder + header.
  for (const scope of SKILL_SCOPE_ORDER) {
    if (usedSegments.get(scope)?.size === 0) {
      paths.push(`${scopeLabel[scope]}/${EMPTY_SCOPE_SENTINEL}`);
    }
  }

  // Restore folders the user manually expanded across a remount: the set of all
  // valid folder tree paths is the scope rows + every managed/detected skill's
  // folder; keep only the ones the inner tree recorded as expanded.
  const validFolderPaths = new Set<string>();
  for (const scope of SKILL_SCOPE_ORDER) validFolderPaths.add(`${scopeLabel[scope]}/`);
  for (const prefix of skillByPrefix.keys()) validFolderPaths.add(`${prefix}/`);
  for (const prefix of detectedByPrefix.keys()) validFolderPaths.add(`${prefix}/`);
  for (const p of userExpanded) {
    if (validFolderPaths.has(p)) expanded.push(p);
  }

  return { paths, expanded, activePath, skillByPrefix, detectedByPrefix };
}
