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

export const EMPTY_SCOPE_SENTINEL = '__ok_empty_scope__';

const OK_OWN_SKILLS: ReadonlySet<string> = new Set([
  'open-knowledge',
  'open-knowledge-discovery',
  'open-knowledge-write-skill',
]);

function pluginOf(s: CatalogSkill): string | null {
  return s.provenance.plugin?.trim() || null;
}

function isManagedDuplicate(s: CatalogSkill, managedNames: ReadonlySet<string>): boolean {
  return pluginOf(s) === null && managedNames.has(s.name);
}

export function detectedId(s: CatalogSkill): string {
  return `${catalogRawScopeToOkScope(s.provenance.scope)}::${s.name}`;
}

export interface SkillsTreePathsInput {
  skills: readonly SkillsListEntry[];
  detected: readonly CatalogSkill[] | null;
  scopeLabel: Record<SkillScope, string>;
  filesByKey: Record<string, readonly { path: string }[]>;
  detectedFilesById: Record<string, readonly string[]>;
  userExpanded: ReadonlySet<string>;
  hostQualifierOf: (s: SkillsListEntry) => string | undefined;
  rowKeyFor: (s: SkillsListEntry) => string;
  isSkillMdActive: (s: SkillsListEntry) => boolean;
  isFileActive: (s: SkillsListEntry, filePath: string) => boolean;
  isDetectedActive: (s: CatalogSkill) => boolean;
  showSkillGroups?: boolean;
  pinnedByScope?: Readonly<Record<SkillScope, ReadonlySet<string>>>;
}

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
  groupByPrefix: Map<string, ProvenanceBucket>;
  pinnedPrefixes: Set<string>;
}

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
  const expanded: string[] = [];
  const usedSegments = new Map<SkillScope, Set<string>>(
    SKILL_SCOPE_ORDER.map((s) => [s, new Set<string>()]),
  );
  for (const scope of SKILL_SCOPE_ORDER) {
    paths.push(`${scopeLabel[scope]}/`);
    expanded.push(`${scopeLabel[scope]}/`);
  }
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
      const existing = bucketOf.get(k);
      if (!existing || (!existing.parent && b.parent)) bucketOf.set(k, b);
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

  const sourceSegmentOf = (
    scope: SkillScope,
    id: string,
    publisher: string | null,
    marketplace = false,
  ): string => {
    const ok = `${scope}\x00${id}`;
    const owners = sourceIdOwners.get(ok);
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
        childGroups.set(pk, (childGroups.get(pk) ?? 0) + 1);
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
        singleRows.set(pk, (singleRows.get(pk) ?? 0) + count);
        if (!parentMetaOf.has(pk)) parentMetaOf.set(pk, b);
      }
    }
    const parentKeys = new Set([...childGroups.keys(), ...singleRows.keys()]);
    for (const pk of parentKeys) {
      const groups = childGroups.get(pk) ?? 0;
      const scope = pk.split('\x00')[0] as SkillScope;
      const parentId = pk.slice(pk.indexOf('\x00') + 1);
      if (skillSegmentsByScope.get(scope)?.has(parentId)) continue;
      if (groups + (singleRows.get(pk) ?? 0) >= 2) parentForms.add(pk);
    }
  }

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
      if (parentOn) return registerParent();
      if (!childOn) return null;
      if (skillSegmentsByScope.get(scope)?.has(b.id)) return null;
      const prefix = `${scopeLabel[scope]}/${b.id}`;
      registerGroup(prefix, b);
      return b.id;
    }
    if (parentOn) return registerParent();
    if (!childOn) return null;
    const seg = sourceSegmentOf(scope, b.id, b.publisher);
    if (skillSegmentsByScope.get(scope)?.has(seg)) return null;
    const prefix = `${scopeLabel[scope]}/${seg}`;
    registerGroup(prefix, b);
    return seg;
  };

  const pinnedPrefixes = new Set<string>();
  const isPinnedName = (scope: SkillScope, name: string): boolean =>
    pinnedByScope?.[scope]?.has(name) ?? false;

  for (const s of skills) {
    const bucket = bucketForSkill(s);
    const pinned = isPinnedName(s.scope, s.name);
    const group = groupSegmentFor(s.scope, bucket);
    const segment = segmentFor(s);
    usedSegments.get(s.scope)?.add(segment);
    const parent = group === null ? scopeLabel[s.scope] : `${scopeLabel[s.scope]}/${group}`;
    const homePrefix = `${parent}/${segment}`;
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
    const taken = (seg: string): boolean =>
      skillByPrefix.has(`${parent}/${seg}`) || detectedByPrefix.has(`${parent}/${seg}`);
    let segment = skillDisplayName(s.name);
    if (taken(segment)) segment = s.name;
    const plugin = pluginOf(s);
    if (taken(segment) && plugin) segment = `${s.name} (${plugin})`;
    if (taken(segment)) continue;
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
    const detectedFiles = detectedFilesById[detectedId(s)] ?? [];
    for (const rel of detectedFiles) {
      for (const p of roots) paths.push(`${p}/${rel}`);
    }
    if (detectedFiles.length > 0) {
      for (const p of roots) expanded.push(`${p}/`);
    }
  }

  for (const scope of SKILL_SCOPE_ORDER) {
    if (usedSegments.get(scope)?.size === 0) {
      paths.push(`${scopeLabel[scope]}/${EMPTY_SCOPE_SENTINEL}`);
    }
  }

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
