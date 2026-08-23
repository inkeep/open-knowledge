import {
  type CatalogSkill,
  catalogRawScopeToOkScope,
  type SkillScope,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import {
  bucketForDetected,
  bucketForSkill,
  bucketKey,
  type ProvenanceBucket,
} from '@/lib/skill-provenance-bucket';
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

/** The plugin a detected skill is a resident of, or null when it is a bare skill dir. */
function pluginOf(s: CatalogSkill): string | null {
  return s.provenance.plugin?.trim() || null;
}

/**
 * Is this detected skill already on screen as a MANAGED row?
 *
 * The usual case is yes: OK installs a skill by writing the bundle and linking it
 * into the harness, so the scan re-finds OK's own file and a name match means the
 * managed row already represents it. A PLUGIN resident is the exception — it lives
 * in the harness's plugin cache, so a managed skill of the same name is a separate
 * file the user copied out of the plugin, and both are real. Suppressing it by name
 * is why an installed plugin's own copies (`pr`, `1on1`) were missing from the
 * plugin's group: the group promises to list what the plugin ships, and quietly
 * did not list the ones the user had also copied.
 */
function isManagedDuplicate(s: CatalogSkill, managedNames: ReadonlySet<string>): boolean {
  return pluginOf(s) === null && managedNames.has(s.name);
}

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
  /** `appearance.sidebar.showSkillGroups`. Off renders the flat tree unchanged. */
  showSkillGroups?: boolean;
  /** Pinned skill NAMES per scope. A pinned skill floats to the top of its
   *  scope as an ordinary row (no section, no extra level) — leaving its
   *  provenance group if it had one, because a pin is a statement that THIS
   *  row matters more than where it came from. */
  pinnedByScope?: Readonly<Record<SkillScope, ReadonlySet<string>>>;
}

/** Strip what a path segment (and the CSS selector built from it) cannot hold. */
export function sanitizePathSegment(label: string, fallback: string): string {
  const cleaned = label
    .replaceAll('/', ' ')
    .replaceAll('\\', ' ')
    .replaceAll("'", '')
    .replaceAll('"', '')
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export interface SkillsTreePaths {
  paths: string[];
  expanded: string[];
  activePath: string | undefined;
  skillByPrefix: Map<string, SkillsListEntry>;
  detectedByPrefix: Map<string, CatalogSkill>;
  /**
   * `<ScopeLabel>/<GroupId>` → the bucket behind it. The tree is path-driven, so
   * a group is a path SEGMENT and every grouped row gains a level. Position
   * alone can no longer identify a row's parts (authored rows and flattened
   * singletons have no group segment), so `parseTreePath` consults this instead
   * of counting slashes.
   */
  groupByPrefix: Map<string, ProvenanceBucket>;
  /** Row prefixes (`<ScopeLabel>/<segment>`) of pinned skills — the sort
   *  floats them to the top of their scope and the tree marks them. */
  pinnedPrefixes: Set<string>;
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
  showSkillGroups = false,
  pinnedByScope,
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
  // Bucket sizes PER SCOPE, computed before any path is emitted: a bucket only
  // earns a group row at 2+, and a bucket of one collapses onto the skill row
  // (which then carries the mark, since it is the row naming the source). Pierre
  // already does this for single-child folders, so the shape is familiar.
  //
  // Counted across managed AND detected skills together, because a copy made out
  // of a plugin is managed while its siblings are still detected — splitting the
  // count would strand the copy in a group of one beside the group it belongs to.
  const groupByPrefix = new Map<string, ProvenanceBucket>();
  const bucketCounts = new Map<string, number>();
  const bucketOf = new Map<string, ProvenanceBucket>();
  const sourceIdOwners = new Map<string, Set<string>>();
  const marketplaceOwners = new Map<string, Set<string>>();
  const GENERIC_SOURCE_TAILS = new Set(['skills', 'agent-skills', 'claude-skills', 'ai-skills']);
  if (showSkillGroups) {
    const bump = (scope: SkillScope, b: ProvenanceBucket | null) => {
      if (!b) return;
      const k = `${scope}\x00${bucketKey(b)}`;
      bucketCounts.set(k, (bucketCounts.get(k) ?? 0) + 1);
      // Prefer the parent-RICH bucket: a managed copy knows its marketplace
      // while a detected resident of the same plugin may not, and the parent
      // tier should form off whichever population can name it.
      const existing = bucketOf.get(k);
      if (!existing || (!existing.parent && b.parent)) bucketOf.set(k, b);
      // Track which KNOWN owners use each source id per scope: source ids are
      // repo TAILS, and two owners' repos sharing a tail (anthropics/skills vs
      // mattpocock/skills) are distinct sources whose folder rows would
      // otherwise fight over one path segment. Unknown is NOT an owner — one
      // marketplace's populations disagree on whether they can name it (a
      // detected plugin carries the repo URL, a cache-copied skill does not),
      // and counting null would split that one marketplace into (?) twins.
      const noteOwner = (id: string, publisher: string | null, marketplace: boolean) => {
        if (!publisher) return;
        const ok = `${scope}\x00${id}`;
        const owners = sourceIdOwners.get(ok) ?? new Set<string>();
        owners.add(publisher);
        sourceIdOwners.set(ok, owners);
        if (marketplace) {
          const mowners = marketplaceOwners.get(ok) ?? new Set<string>();
          mowners.add(publisher);
          marketplaceOwners.set(ok, mowners);
        }
      };
      if (b.kind === 'source') noteOwner(b.id, b.publisher, false);
      if (b.parent) noteOwner(b.parent.id, b.parent.publisher, b.parent.marketplace === true);
    };
    for (const s of skills) bump(s.scope, bucketForSkill(s));
    const managedNamesForCount = new Set(skills.map((s) => s.name));
    for (const d of detected ?? []) {
      if (isManagedDuplicate(d, managedNamesForCount) || OK_OWN_SKILLS.has(d.name)) continue;
      bump(catalogRawScopeToOkScope(d.provenance.scope), bucketForDetected(d));
    }
  }

  /**
   * Segments claimed by a skill that will render at SCOPE level, computed before
   * any group is formed. A group and a scope-level skill are both folder rows at
   * the same level, so a source or plugin whose id equals one of those segments
   * would share one path prefix — Pierre renders them as a single folder and the
   * row lookups resolve to whichever map is consulted first.
   *
   * Only scope-level skills count, and that restriction is the whole point. A
   * plugin named after its own flagship skill is the common case, not the corner
   * one (`ponytail` ships a `ponytail` skill; so does `eng`-style tooling), and
   * that member nests INSIDE the group at `<scope>/<plugin>/<skill>` where the
   * group's name cannot clash with it. Counting every skill made those plugins
   * collide with themselves and silently refuse to group — the tree showed six
   * flat `ponytail-*` rows next to correctly-grouped neighbours.
   *
   * A skill renders at scope level when it has no bucket or its bucket is a
   * single. A bucket suppressed by a collision of its own would also land here,
   * which this deliberately does not chase: the cascade needs two groups whose
   * ids each match the other's members, and one extra flat row beats a fixpoint
   * loop over the whole library.
   *
   * When a collision IS real, the bucket simply does not form and its members
   * render flat with their own marks — the same shape a bucket of one takes.
   * Renaming either side would be worse: the group's id is the publisher or
   * plugin name a user recognises, and the skill's segment is the name it is
   * installed under.
   */
  // Plugin/pack buckets ALWAYS group — a plugin is an installable identity and
  // reads as one even holding a single skill. Only generic source groups keep
  // the two-member floor (a source folder of one is noise, a plugin isn't).
  const rendersAtScopeLevel = (scope: SkillScope, b: ProvenanceBucket | null): boolean =>
    !b || (b.kind !== 'plugin' && (bucketCounts.get(`${scope}\x00${bucketKey(b)}`) ?? 0) < 2);
  const skillSegmentsByScope = new Map<SkillScope, Set<string>>(
    SKILL_SCOPE_ORDER.map((sc) => [sc, new Set<string>()]),
  );
  for (const sk of skills) {
    if (!rendersAtScopeLevel(sk.scope, bucketForSkill(sk))) continue;
    skillSegmentsByScope.get(sk.scope)?.add(segmentFor(sk));
  }
  for (const d of detected ?? []) {
    if (OK_OWN_SKILLS.has(d.name)) continue;
    const scope = catalogRawScopeToOkScope(d.provenance.scope);
    if (!rendersAtScopeLevel(scope, bucketForDetected(d))) continue;
    skillSegmentsByScope.get(scope)?.add(skillDisplayName(d.name));
  }

  /**
   * Which PARENT tiers (repo / marketplace over its packs / plugins) form a
   * folder row of their own. A parent forms only when it would hold more than
   * one direct row — at least one child group plus something else beside it
   * (another child group, a loose skill from the same source, or a singleton
   * child's member). A parent of exactly one child collapses away and the
   * child renders alone, exactly as a group of one collapses to a flat skill.
   */
  // A source's visible segment. Naming the repo "skills" is the ecosystem
  // convention (anthropics/skills, mattpocock/skills, …), so a generic tail
  // carries no signal — the OWNER is the identity, and the folder labels by
  // it, exactly as skills.sh addresses publishers. A distinctive tail keeps
  // its short name, qualifying with the publisher only when several owners
  // share it in this scope.
  const sourceSegmentOf = (
    scope: SkillScope,
    id: string,
    publisher: string | null,
    marketplace = false,
  ): string => {
    const ok = `${scope}\x00${id}`;
    const owners = sourceIdOwners.get(ok);
    // A publisher-less MARKETPLACE parent adopts the registry entry's known
    // owner: registry names are unique per installation, so same id is
    // provably the same marketplace. A repo tail has no such guarantee and
    // never adopts — a bare-URL import is not provably anyone's repo.
    const mowners = marketplace ? marketplaceOwners.get(ok) : undefined;
    const known = publisher ?? (mowners?.size === 1 ? [...mowners][0] : null) ?? null;
    if (GENERIC_SOURCE_TAILS.has(id.toLowerCase()) && known) return known;
    if ((owners?.size ?? 0) > 1) return `${id} (${known ?? '?'})`;
    return id;
  };

  const parentForms = new Set<string>();
  const parentMetaOf = new Map<string, ProvenanceBucket>();
  if (showSkillGroups) {
    const childGroups = new Map<string, number>();
    const singleRows = new Map<string, number>();
    for (const [k, count] of bucketCounts) {
      const b = bucketOf.get(k);
      if (!b) continue;
      const scope = k.split('\x00')[0] as SkillScope;
      const parentId = b.parent
        ? sourceSegmentOf(scope, b.parent.id, b.parent.publisher, b.parent.marketplace === true)
        : b.kind === 'source'
          ? sourceSegmentOf(scope, b.id, b.publisher)
          : null;
      if (parentId === null) continue;
      const pk = `${scope}\x00${parentId}`;
      if (b.parent) {
        // Parented buckets are plugin/pack identities — they always render as
        // a child group, so each is one direct row under the parent.
        childGroups.set(pk, (childGroups.get(pk) ?? 0) + 1);
        // Populations disagree on how much they know about the parent (a
        // managed copy's cache path carries no repo URL; the detected resident
        // does) — keep whichever version can link and show an avatar.
        const known = parentMetaOf.get(pk);
        if (!known || (known.url === null && b.parent.url !== null)) {
          parentMetaOf.set(pk, {
            kind: 'source',
            id: parentId,
            publisher: b.parent.publisher ?? known?.publisher ?? null,
            url: b.parent.url ?? known?.url ?? null,
          });
        }
      } else {
        // The source bucket itself: its members are loose rows under the parent.
        singleRows.set(pk, (singleRows.get(pk) ?? 0) + count);
        if (!parentMetaOf.has(pk)) parentMetaOf.set(pk, b);
      }
    }
    // Union of every parent either map saw: a parent with NO formed child
    // group (a one-skill pack beside a loose import) must still be considered,
    // or two skills from one repo render flat where they used to group.
    const parentKeys = new Set([...childGroups.keys(), ...singleRows.keys()]);
    for (const pk of parentKeys) {
      const groups = childGroups.get(pk) ?? 0;
      const scope = pk.split('\x00')[0] as SkillScope;
      const parentId = pk.slice(pk.indexOf('\x00') + 1);
      if (skillSegmentsByScope.get(scope)?.has(parentId)) continue; // collision → no parent tier
      if (groups + (singleRows.get(pk) ?? 0) >= 2) parentForms.add(pk);
    }
  }

  /**
   * The path segment CHAIN a skill nests under (`repo/pack`, one segment, or
   * `null` to sit directly in its scope). Registers every level in
   * `groupByPrefix` so `parseTreePath` can recognise the extra levels.
   */
  // Register a group's bucket without letting a metadata-poor member clobber a
  // rich one: members disagree on what they know (a managed copy's cache path
  // carries no repo URL; the detected resident of the same plugin does), and
  // the group's mark should link whenever ANY member can name the destination.
  const registerGroup = (prefix: string, b: ProvenanceBucket): void => {
    const known = groupByPrefix.get(prefix);
    if (!known) {
      groupByPrefix.set(prefix, b);
      return;
    }
    if (
      (known.url === null && b.url !== null) ||
      (known.publisher === null && b.publisher !== null)
    ) {
      groupByPrefix.set(prefix, {
        ...known,
        publisher: known.publisher ?? b.publisher,
        url: known.url ?? b.url,
      });
    }
  };

  const groupSegmentFor = (scope: SkillScope, b: ProvenanceBucket | null): string | null => {
    if (!showSkillGroups || !b) return null;
    const childOn =
      b.kind === 'plugin' || (bucketCounts.get(`${scope}\x00${bucketKey(b)}`) ?? 0) >= 2;
    const parentId = b.parent
      ? sourceSegmentOf(scope, b.parent.id, b.parent.publisher, b.parent.marketplace === true)
      : b.kind === 'source'
        ? sourceSegmentOf(scope, b.id, b.publisher)
        : null;
    const pk = parentId !== null ? `${scope}\x00${parentId}` : null;
    const parentOn = pk !== null && parentForms.has(pk);
    const registerParent = (): string => {
      const parentBucket = parentMetaOf.get(pk as string) as ProvenanceBucket;
      registerGroup(`${scopeLabel[scope]}/${parentId}`, parentBucket);
      return parentId as string;
    };
    if (b.parent) {
      if (parentOn && childOn) {
        const parentSeg = registerParent();
        const chain = `${parentSeg}/${b.id}`;
        registerGroup(`${scopeLabel[scope]}/${chain}`, b);
        return chain;
      }
      if (parentOn) return registerParent(); // singleton child member → loose under parent
      if (!childOn) return null;
      if (skillSegmentsByScope.get(scope)?.has(b.id)) return null; // collision → stay flat
      const prefix = `${scopeLabel[scope]}/${b.id}`;
      registerGroup(prefix, b);
      return b.id;
    }
    if (parentOn) return registerParent(); // loose source member under the formed parent
    if (!childOn) return null;
    const seg = sourceSegmentOf(scope, b.id, b.publisher);
    if (skillSegmentsByScope.get(scope)?.has(seg)) return null; // collision → stay flat
    const prefix = `${scopeLabel[scope]}/${seg}`;
    registerGroup(prefix, b);
    return seg;
  };

  // A pin floats a row to the top of its scope: no PINNED section, no extra
  // level — the sort lifts it and the tree marks it by these prefixes. An
  // UNGROUPED skill's own row simply floats. A GROUPED skill keeps its group
  // row (a group lists everything from its source — that promise survives the
  // pin) and ALSO emits a floated twin at scope level; both resolve to the
  // same entry, so either opens it.
  const pinnedPrefixes = new Set<string>();
  const isPinnedName = (scope: SkillScope, name: string): boolean =>
    pinnedByScope?.[scope]?.has(name) ?? false;

  for (const s of skills) {
    const bucket = bucketForSkill(s);
    const pinned = isPinnedName(s.scope, s.name);
    const group = groupSegmentFor(s.scope, bucket);
    // Only an UNGROUPED skill can collide with a group id — one nested INSIDE a
    // group already sits a level deeper, where the group's own name cannot clash.
    const segment = segmentFor(s);
    usedSegments.get(s.scope)?.add(segment);
    const parent = group === null ? scopeLabel[s.scope] : `${scopeLabel[s.scope]}/${group}`;
    const homePrefix = `${parent}/${segment}`;
    // Grouped + pinned → the floated twin leads; the group row stays. The twin
    // is the ACTIVE root so opens land on the row the user made.
    const roots =
      pinned && group !== null ? [`${scopeLabel[s.scope]}/${segment}`, homePrefix] : [homePrefix];
    const activeRoot = roots[0] as string;
    if (pinned) pinnedPrefixes.add(activeRoot);
    for (const p of roots) {
      skillByPrefix.set(p, s);
      paths.push(`${p}/${SKILL_MD_PATH}`);
    }
    if (isSkillMdActive(s)) {
      activePath = `${activeRoot}/${SKILL_MD_PATH}`;
      expanded.push(`${scopeLabel[s.scope]}/`, `${parent}/`, `${activeRoot}/`);
    }
    for (const f of filesByKey[rowKeyFor(s)] ?? []) {
      for (const p of roots) paths.push(`${p}/${f.path}`);
      if (!activePath && isFileActive(s, f.path)) {
        activePath = `${activeRoot}/${f.path}`;
        expanded.push(`${scopeLabel[s.scope]}/`, `${parent}/`, `${activeRoot}/`);
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
    if (isManagedDuplicate(s, managedNames) || OK_OWN_SKILLS.has(s.name)) continue;
    const scope = catalogRawScopeToOkScope(s.provenance.scope);
    const used = usedSegments.get(scope);
    if (!used) continue;
    const pinned = isPinnedName(scope, s.name);
    const group = groupSegmentFor(scope, bucketForDetected(s));
    const parent = group === null ? scopeLabel[scope] : `${scopeLabel[scope]}/${group}`;
    // Collisions are per PARENT, not per scope: a resident nested in its plugin's
    // group cannot clash with a scope-level row, and asking the scope would drop
    // it for a name that is only taken a level up. Third tier is the plugin that
    // ships it — the thing that actually distinguishes a resident from the copy
    // the user made of it, which is the pair this tree now shows side by side.
    const taken = (seg: string): boolean =>
      skillByPrefix.has(`${parent}/${seg}`) || detectedByPrefix.has(`${parent}/${seg}`);
    let segment = skillDisplayName(s.name);
    if (taken(segment)) segment = s.name;
    const plugin = pluginOf(s);
    if (taken(segment) && plugin) segment = `${s.name} (${plugin})`;
    if (taken(segment)) continue; // hard collision (rare) → don't hide a real row
    used.add(segment);
    const homePrefix = `${parent}/${segment}`;
    const roots =
      pinned && group !== null ? [`${scopeLabel[scope]}/${segment}`, homePrefix] : [homePrefix];
    const activeRoot = roots[0] as string;
    if (pinned) pinnedPrefixes.add(activeRoot);
    for (const p of roots) {
      detectedByPrefix.set(p, s);
      paths.push(`${p}/${SKILL_MD_PATH}`);
    }
    if (!activePath && isDetectedActive(s)) {
      activePath = `${activeRoot}/${SKILL_MD_PATH}`;
      expanded.push(`${scopeLabel[scope]}/`, `${parent}/`, `${activeRoot}/`);
    }
    // Once loaded, nest the detected skill's reference/script files under it and
    // keep it expanded so the tree it just revealed doesn't collapse on re-render.
    const detectedFiles = detectedFilesById[detectedId(s)] ?? [];
    for (const rel of detectedFiles) {
      for (const p of roots) paths.push(`${p}/${rel}`);
    }
    if (detectedFiles.length > 0) {
      for (const p of roots) expanded.push(`${p}/`);
    }
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
  for (const prefix of groupByPrefix.keys()) validFolderPaths.add(`${prefix}/`);
  for (const p of userExpanded) {
    if (validFolderPaths.has(p)) expanded.push(p);
  }

  return {
    paths,
    expanded,
    activePath,
    skillByPrefix,
    detectedByPrefix,
    groupByPrefix,
    pinnedPrefixes,
  };
}
