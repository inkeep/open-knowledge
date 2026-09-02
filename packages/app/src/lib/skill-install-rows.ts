import type {
  SkillInstallTarget,
  SkillsListEntry,
  SkillTargetEditor,
  SkillUserTargetEditor,
} from '@inkeep/open-knowledge-core';
import { SkillTargetEditorSchema, SkillUserTargetEditorSchema } from '@inkeep/open-knowledge-core';
import { customPlacementRoot, pluginCoverageOf, skillHostRootDir } from '@/lib/skill-scope';

export const INSTALL_EDITORS: readonly SkillTargetEditor[] = SkillTargetEditorSchema.options;
export const GLOBAL_INSTALL_EDITORS: readonly SkillUserTargetEditor[] =
  SkillUserTargetEditorSchema.options;

const AGENTS_DIR_PREFIX = '.agents/';

export { pluginCoverageOf };

export type SkillInstallMenuSkill = Pick<SkillsListEntry, 'scope' | 'name'> &
  Partial<
    Pick<
      SkillsListEntry,
      | 'hosts'
      | 'symlinkedHosts'
      | 'path'
      | 'customPlacements'
      | 'hostAliases'
      | 'conflictHosts'
      | 'driftPaths'
      | 'installableEditors'
      | 'hubOffered'
      | 'origin'
      | 'plugin'
    >
  >;

export interface SkillInstallRowsInput {
  skill: SkillInstallMenuSkill | undefined;
  allSkills: readonly SkillsListEntry[] | null;
  hostSet: ReadonlySet<string>;
  sourceHostOverlay: string | undefined;
  linkMode: boolean;
}

interface SkillConvertibleLocation {
  target: string;
  display: string;
  mode: 'copy' | 'link';
}

interface SkillCustomRootRow {
  root: string;
  display: string;
  placed: { path: string; mode: 'copy' | 'link' } | null;
}

export interface SkillInstallRows {
  pathFor: (host: string) => string | null;
  aliases: Record<string, string>;
  rows: SkillInstallTarget[];
  sourceRow: string | null;
  sourceHost: string | undefined;
  conflicted: ReadonlySet<string>;
  drifted: ReadonlySet<string>;
  linked: ReadonlySet<string>;
  expectedMode: 'copy' | 'link';
  convertible: SkillConvertibleLocation[];
  customRootRows: SkillCustomRootRow[];
}

export function deriveSkillInstallRows({
  skill,
  allSkills,
  hostSet,
  sourceHostOverlay,
  linkMode,
}: SkillInstallRowsInput): SkillInstallRows {
  const pathFor = (host: string): string | null =>
    skill ? `${skillHostRootDir(host, skill.scope)}/${skill.name}` : null;

  const hubOffered =
    skill?.hubOffered ??
    (skill && allSkills !== null
      ? allSkills.find((s) => s.scope === skill.scope)?.hubOffered
      : undefined);
  const hubActive =
    skill !== undefined &&
    (hubOffered === true ||
      (skill.hosts ?? []).includes('agents') ||
      allSkills?.some(
        (s) =>
          s.scope === skill.scope &&
          (s.hosts.includes('agents') || s.path.startsWith(AGENTS_DIR_PREFIX)),
      ));

  const aliases: Record<string, string> =
    skill?.hostAliases ??
    (skill && allSkills !== null
      ? Object.assign(
          {},
          ...allSkills.filter((s) => s.scope === skill.scope).map((s) => s.hostAliases ?? {}),
        )
      : {});

  const installableList: readonly string[] | undefined =
    skill?.installableEditors ??
    (skill && allSkills !== null
      ? allSkills.find((s) => s.scope === skill.scope)?.installableEditors
      : undefined);
  const installable = installableList ? new Set<string>(installableList) : null;
  const editorBase = skill?.scope === 'global' ? GLOBAL_INSTALL_EDITORS : INSTALL_EDITORS;
  const rows: SkillInstallTarget[] = (
    hubActive ? ([...editorBase, 'agents'] as SkillInstallTarget[]) : editorBase
  )
    .filter((e) => !(e in aliases))
    .filter((e) => e === 'agents' || installable === null || installable.has(e) || hostSet.has(e));

  const stdPaths = new Set(rows.map((e) => pathFor(e)));
  const homePrefix = skill?.scope === 'global' ? '~/' : '';
  const entryDir = skill?.path?.includes('/')
    ? `${homePrefix}${skill.path.replace(/\/SKILL\.mdx?$/i, '')}`
    : null;
  const sourceRow = entryDir !== null && !stdPaths.has(entryDir) ? entryDir : null;
  const sourceHost = sourceRow === null ? (sourceHostOverlay ?? skill?.hosts?.[0]) : undefined;

  const conflicted = new Set(skill?.conflictHosts ?? []);
  const drifted = new Set(skill?.driftPaths ?? []);
  const linked = new Set(skill?.symlinkedHosts ?? []);

  const convertible: SkillConvertibleLocation[] = [
    ...[...hostSet]
      .filter((h) => h !== sourceHost && !(h in aliases) && !conflicted.has(h) && !h.includes('/'))
      .map((h) => ({
        target: h,
        display: pathFor(h) ?? h,
        mode: linked.has(h) ? ('link' as const) : ('copy' as const),
      })),
    ...(skill?.customPlacements ?? []).map((cp) => ({
      target: customPlacementRoot(cp),
      display: `${homePrefix}${cp.path}`,
      mode: cp.mode,
    })),
  ];

  const otherStates = convertible.map((c) => c.mode);
  const linkCount = otherStates.filter((st) => st === 'link').length;
  const expectedMode: 'copy' | 'link' =
    otherStates.length === 0
      ? linkMode
        ? 'link'
        : 'copy'
      : linkCount * 2 >= otherStates.length
        ? 'link'
        : 'copy';

  const myPlacements = new Map(
    (skill?.customPlacements ?? []).map((cp) => [customPlacementRoot(cp), cp]),
  );
  const knownRoots = new Set<string>(myPlacements.keys());
  if (allSkills !== null && skill) {
    for (const s of allSkills) {
      if (s.scope !== skill.scope) continue;
      for (const cp of s.customPlacements ?? []) {
        const root = customPlacementRoot(cp);
        if (root !== '') knownRoots.add(root);
      }
    }
  }
  const customRootRows: SkillCustomRootRow[] =
    skill !== undefined
      ? [...knownRoots]
          .sort()
          .map((root) => ({
            root,
            display: `${homePrefix}${root}/${skill.name}`,
            placed: myPlacements.get(root) ?? null,
          }))
          .filter((r) => !stdPaths.has(r.display) && r.display !== entryDir && !(r.root in aliases))
      : [];

  return {
    pathFor,
    aliases,
    rows,
    sourceRow,
    sourceHost,
    conflicted,
    drifted,
    linked,
    expectedMode,
    convertible,
    customRootRows,
  };
}
