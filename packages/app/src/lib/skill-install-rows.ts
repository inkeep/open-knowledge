import type {
  SkillInstallTarget,
  SkillsListEntry,
  SkillTargetEditor,
} from '@inkeep/open-knowledge-core';
import { SkillTargetEditorSchema } from '@inkeep/open-knowledge-core';
import { customPlacementRoot, skillHostRootDir } from '@/lib/skill-scope';

/**
 * The install menu's row derivation — which locations are offered, which are
 * occupied, what form each is in, and which of them a convert would rewrite.
 *
 * Pure, and extracted from the menu component because it is the part with
 * actual decisions in it: alias-covered roots get no row of their own, the
 * `.agents` hub is existence-activated rather than always offered, and
 * `expectedMode` is a majority vote over the skill's OTHER locations that
 * decides both the per-row convert tags and what a NEW location lands as. The
 * JSX around it stays where it is.
 */

/** The editors a project skill can install into — the narrowed `.options` of the
 *  canonical schema, so this can never drift from the install verb + picker. */
export const INSTALL_EDITORS: readonly SkillTargetEditor[] = SkillTargetEditorSchema.options;

/** A skill living anywhere under `.agents/` counts as the project having adopted
 *  the hub, not just one directly in `AGENTS_SKILLS_ROOT`. Deliberately a
 *  literal and not derived from that constant: the adoption MARKER ("does this
 *  project use `.agents/` at all?") is a different question from the hub's
 *  install path, and deriving one from the other would silently broaden this
 *  check if the hub ever moved to a nested path. Same bare form as the other
 *  reader of this concept, `AgentIconCluster`. */
const AGENTS_DIR_PREFIX = '.agents/';

/** What the menu knows about the skill. An un-imported explore preview carries
 *  only `{scope, name}`, so every detail field is optional. */
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
    >
  >;

export interface SkillInstallRowsInput {
  skill: SkillInstallMenuSkill | undefined;
  /** Every skill at any scope, or null while the list has not loaded. Several
   *  derivations fall back to the same-scope union across it for a preview skill
   *  that carries no entry of its own. */
  allSkills: readonly SkillsListEntry[] | null;
  /** Hosts the skill occupies, overlay applied. */
  hostSet: ReadonlySet<string>;
  /** Source host with the optimistic overlay applied. */
  sourceHostOverlay: string | undefined;
  /** The server's effective fan-out preference, used only when the skill has no
   *  other location to compare against. */
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
  /** Display path for a host row, or null when there is no skill. */
  pathFor: (host: string) => string | null;
  /** Folder-level aliases (host id → base-relative target root). */
  aliases: Record<string, string>;
  /** Host rows to render, in order. */
  rows: SkillInstallTarget[];
  /** The skill's own folder when it is NOT one of the host rows, in display
   *  form (`~/`-prefixed at global scope). */
  sourceRow: string | null;
  /** The host row that carries the SOURCE badge, if any. */
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

  // The `.agents` hub is EXISTENCE-ACTIVATED: offered only when this project
  // already adopted it (any skill lives there or lists it as a host). OK never
  // pushes the hub on a repo — adopting it is one Custom path away, and the
  // first placement there lights this row up for every skill.
  const hubActive =
    skill !== undefined &&
    ((skill.hosts ?? []).includes('agents') ||
      allSkills?.some((s) => s.hosts.includes('agents') || s.path.startsWith(AGENTS_DIR_PREFIX)));

  // Folder-level aliases. An aliased folder is a derived view of its target: NO
  // row of its own (checking it could only write through the alias), its agent
  // icon rides the target root's row instead. Folder-level links are a property
  // of the SCOPE's dirs, not of one skill — a not-yet-installed skill has no
  // entry to carry them, so fall back to the union across installed same-scope
  // skills; otherwise the preview menu shows aliased folders as plain rows.
  const aliases: Record<string, string> =
    skill?.hostAliases ??
    (skill && allSkills !== null
      ? Object.assign(
          {},
          ...allSkills.filter((s) => s.scope === skill.scope).map((s) => s.hostAliases ?? {}),
        )
      : {});

  // Only OFFER editors installable on THIS machine for the skill's scope — for
  // global skills that is the set whose user-home dir exists, so we don't show
  // an editor whose install silently no-ops and flashes a checkmark that
  // reverts. Same same-scope fallback as `aliases`; null = no data → offer
  // everything (never over-hide). The `.agents` hub and any editor the skill is
  // ALREADY in are always kept (uninstall stays reachable).
  const installableList: readonly string[] | undefined =
    skill?.installableEditors ??
    (skill && allSkills !== null
      ? allSkills.find((s) => s.scope === skill.scope)?.installableEditors
      : undefined);
  const installable = installableList ? new Set<string>(installableList) : null;
  const rows: SkillInstallTarget[] = (
    hubActive ? (['agents', ...INSTALL_EDITORS] as SkillInstallTarget[]) : INSTALL_EDITORS
  )
    .filter((e) => !(e in aliases))
    .filter((e) => e === 'agents' || installable === null || installable.has(e) || hostSet.has(e));

  const stdPaths = new Set(rows.map((e) => pathFor(e)));
  const homePrefix = skill?.scope === 'global' ? '~/' : '';
  // `path` is `<dir>/SKILL.md`; the guard on '/' skips placeholder entries.
  const entryDir = skill?.path?.includes('/')
    ? `${homePrefix}${skill.path.replace(/\/SKILL\.mdx?$/i, '')}`
    : null;
  const sourceRow = entryDir !== null && !stdPaths.has(entryDir) ? entryDir : null;
  // A host row carries the SOURCE badge ONLY when the skill's real dir IS that
  // host's dir (in-place skills). A store-backed skill's source is its own row
  // (`sourceRow`) — badging hosts[0] there showed TWO sources.
  const sourceHost = sourceRow === null ? (sourceHostOverlay ?? skill?.hosts?.[0]) : undefined;

  const conflicted = new Set(skill?.conflictHosts ?? []);
  // Drift = OK's record of what it wrote disagrees with disk (another tool
  // rewrote the path). PASSIVE disclosure only.
  const drifted = new Set(skill?.driftPaths ?? []);
  const linked = new Set(skill?.symlinkedHosts ?? []);

  // Every location this skill has BESIDES its source, with the form each one is
  // in. The source is never included: it is the real folder the others copy or
  // point at.
  const convertible: SkillConvertibleLocation[] = [
    ...[...hostSet]
      .filter((h) => h !== sourceHost && !(h in aliases) && !conflicted.has(h) && !h.includes('/'))
      .map((h) => ({
        target: h,
        // `pathFor` is null only when there is no skill at all, in which case
        // there are no hosts to be here for.
        display: pathFor(h) ?? h,
        mode: linked.has(h) ? ('link' as const) : ('copy' as const),
      })),
    ...(skill?.customPlacements ?? []).map((cp) => ({
      target: customPlacementRoot(cp),
      display: `${homePrefix}${cp.path}`,
      mode: cp.mode,
    })),
  ];

  // The mode a location is EXPECTED to have: what the skill's other locations
  // are, falling back to the server's effective preference when there are none
  // to compare against. A row matching this says nothing (a menu of identical
  // COPY tags was pure noise); a row that DIVERGES gets a tag that converts it.
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

  // Non-standard locations that actually hold this skill get their own rows.
  // KNOWN custom roots travel between SKILLS (per-machine): every distinct
  // parent dir any skill at this scope has a recorded placement under becomes an
  // offerable row on EVERY skill's menu. Checked when THIS skill is placed there.
  const myPlacements = new Map(
    (skill?.customPlacements ?? []).map((cp) => [customPlacementRoot(cp), cp]),
  );
  const knownRoots = new Set<string>(myPlacements.keys());
  if (allSkills !== null && skill) {
    for (const s of allSkills) {
      if (s.scope !== skill.scope) continue;
      for (const cp of s.customPlacements ?? []) {
        const root = customPlacementRoot(cp);
        // `.ok/skills` is the retired store, offered like any other custom root
        // so projects that still keep skills there can manage them; the rest of
        // `.ok/` is OK's own state and the server refuses it.
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
          // Alias-covered custom roots (a folder-symlink into another root) get
          // NO row — same rule as editor folders: their icon rides the target
          // root's audience instead.
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
