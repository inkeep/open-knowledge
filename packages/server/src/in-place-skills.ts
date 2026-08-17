/**
 * In-place skill registry pre-pass (spec: in-place skill versioning).
 *
 * Scan a base dir's editor host skill dirs for bundles, content-hash each
 * (reusing `parseSkillDir`), and dedup via `buildSkillRegistry` — one entry per
 * distinct-CONTENT identity, same-content copies excluded. Two same-named
 * bundles holding different bytes are two skills and both are listed; the name
 * alone was never the identity. Two tiers share the machinery:
 *
 *  - PROJECT (`scanInPlaceSkills(contentDir)`): the canonical dirs become the
 *    `ContentFilter.inPlaceSkillDirs` allow-list (versioned content; boot +
 *    live re-scan on host-dir change).
 *  - GLOBAL (`scanGlobalInPlaceSkills(home)`): user-home editor dirs
 *    (`~/.claude/skills`, `~/.agents/skills`, …). Global skills are NOT
 *    content (no per-user content root); the scan feeds the skills list, and
 *    `resolveGlobalNativeSkillDir` resolves `__skill__/global/<name>` docs to
 *    the native dir when the `~/.ok/skills` store has no entry.
 */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  type EditorId,
  LEGACY_SKILL_STORE_ROOT,
  type SkillScope,
  skillRootActivationPath,
} from '@inkeep/open-knowledge-core';
import {
  buildSkillRegistry,
  groupSkillsByIdentity,
  type LocatedSkillOccurrence,
  parseSkillDir,
  SKILL_CANONICAL_PRECEDENCE,
  type SkillHostId,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { isInternalBundleSkillName } from './skill-bundles.ts';
import {
  readKnownSkillPlacementRoots as readPlacementRoots,
  readSkillSourceHostPreferences as readSourceHostPrefs,
} from './skill-placements-store.ts';

function hostRoots(
  map: Record<EditorId, string | null>,
  agentsRoot: string,
): ReadonlyArray<{ editor: SkillHostId; root: string }> {
  return [
    ...(Object.entries(map) as [EditorId, string | null][])
      .filter((e): e is [EditorId, string] => e[1] !== null)
      .map(([editor, root]) => ({ editor: editor as SkillHostId, root })),
    { editor: 'agents' as SkillHostId, root: agentsRoot },
  ];
}

/** host → project-relative skills root: every editor primary (non-null) plus
 *  the vendor-neutral `.agents/skills` hub (first-class in-place host). */
const EDITOR_SKILL_ROOTS = hostRoots(EDITOR_PROJECT_SKILL_ROOT, AGENTS_SKILLS_ROOT);

/** host → home-relative skills root for USER scope (editors + the `~/.agents` hub). */
const USER_SKILL_ROOTS = hostRoots(EDITOR_USER_SKILL_ROOT, AGENTS_SKILLS_ROOT);

/** One in-place skill the registry canonicalized — the list-surface projection. */
export interface InPlaceSkill {
  /** Bundle dir basename — the projection identity (install copies keep it). */
  readonly name: string;
  /** SKILL.md frontmatter description ('' when absent/malformed). */
  readonly description: string;
  /** contentDir-relative CANONICAL bundle dir, e.g. `.claude/skills/foo`. */
  readonly dir: string;
  /** Editors holding same-hash occurrences of this skill (canonical first). */
  readonly hosts: readonly string[];
  /** Hosts whose occurrence is a SYMLINK (user-authored links are preserved,
   *  and disclosed as links, not silently presented as copies). */
  readonly linkedHosts: readonly string[];
  /** Hosts whose dir holds a DIFFERENT same-name skill — that path is occupied
   *  and is NOT this skill. Those bundles are rows in their own right (they
   *  appear in this same list); this field is the cross-pointer that lets a row
   *  disclose the shared name and keeps the install menu from offering a slot
   *  another skill already owns. Symmetric: each side lists the other. */
  readonly conflictHosts: readonly string[];
  /** Base-relative dirs of the NON-symlink same-hash copies — the observed
   *  copy relationships the forward re-sync records (a symlink is live and
   *  needs no re-sync). */
  readonly copyDirs: readonly string[];
  /** `parseSkillDir` bundle hash of the canonical — the dedup/Modified identity. */
  readonly contentHash: string;
}

interface ScanOccurrence extends LocatedSkillOccurrence {
  readonly description: string;
  readonly viaLink: boolean;
  /** The occurrence lives under an ALIASED root (the folder or a parent is a
   *  symlink) — a VIEW of another location. Never electable as canonical
   *  (folded into `viaLink` for the election sort), never a real copy. */
  readonly aliasRooted?: boolean;
}

/**
 * Host skills roots that are ALIASES of another location — the folder itself
 * (or a parent, e.g. `.codex`) is a symlink resolving to a different dir under
 * `base`. host id → base-relative target root. The locations-menu design keys
 * off this: an aliased folder is a derived view of the target — no menu row,
 * never a write target; its agent icon rides the target root's row. Observable
 * disk facts only (the vendor-capability table is deleted). Roots resolving
 * OUTSIDE `base` are skipped (no in-base row can represent them).
 */
export function scanHostRootAliases(base: string, scope: SkillScope): Record<string, string> {
  // ALL known roots, not just the standard host set: a CUSTOM root that is a
  // folder-symlink into another root (`.tim/skills → .ok/skills`) is an alias
  // exactly like an editor folder — no row of its own, its icon rides the
  // target root's audience, and its occurrences never win election.
  const roots = knownSkillRootsFor(base, scope);
  const out: Record<string, string> = {};
  let baseReal: string;
  try {
    baseReal = realpathSync(base);
  } catch {
    return out;
  }
  for (const { editor, root } of roots) {
    let real: string;
    try {
      real = realpathSync(join(base, root));
    } catch {
      continue; // absent — a real (creatable) location, not an alias
    }
    if (real === join(baseReal, root)) continue;
    if (!real.startsWith(`${baseReal}/`)) continue;
    out[editor] = real.slice(baseReal.length + 1);
  }
  return out;
}

/** Per-host skills roots for a scope (editor primaries + the `.agents` hub) —
 *  the row source for folder-level surfaces (Settings → Skills folders). */
function hostSkillRootsFor(
  scope: SkillScope,
): ReadonlyArray<{ editor: SkillHostId; root: string }> {
  return scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
}

/** ABSOLUTE global skill roots for graph/backlink ingestion: the legacy
 *  `~/.ok/skills` store (until its last resident migrates) plus every native
 *  user skill root — global skills live IN-PLACE now (store retirement), and
 *  their `__skill__/global/<name>` graph nodes are name-keyed, so multiple
 *  roots dedupe naturally. */
export function globalSkillGraphRoots(home: string): string[] {
  // Every known global skill root — the editor dirs, the `.agents` hub, AND the
  // ledger-recorded custom roots. `.ok/skills` used to be prepended by hand as
  // the one non-standard root wired into the global plumbing; it now arrives
  // through the ordinary custom-root path like `.tim/skills`, so a global skill
  // at any custom root is watched and graph-ingested rather than only that one.
  const roots = knownSkillRootsFor(home, 'global').map((r) => join(home, r.root));
  const legacyStore = join(home, '.ok', 'skills');
  // The retired store may still hold residents that have not drained (a name
  // that collides at its migration target never moves), and it is not in the
  // known-roots list unless something recorded a placement there.
  return roots.includes(legacyStore) ? roots : [...roots, legacyStore];
}

/**
 * ALL known skill roots for a base: the standard host roots PLUS the
 * ledger-known custom roots (`.ok/skills`, `.tim/skills`, …) — host id = the
 * root path for customs, exactly like the scan's synthetic occurrence hosts.
 * The Folders surface + folder verbs consume this so custom roots are
 * first-class rows and link targets (no root is privileged).
 */
export function knownSkillRootsFor(
  base: string,
  scope: SkillScope,
): ReadonlyArray<{ editor: string; root: string }> {
  const std = hostSkillRootsFor(scope);
  const seen = new Set(std.map((r) => r.root));
  return [
    ...std,
    ...readPlacementRoots(base)
      .filter((r) => !seen.has(r))
      .map((r) => ({ editor: r, root: r })),
  ];
}

/** The standard host skills roots for a scope (editor primaries + the
 *  `.agents/skills` hub). Ledger records under these are editor-row form
 *  RECEIPTS (leave-behind links, drift expectations), NOT custom placements —
 *  list emission must not present them as custom locations. */
export function standardSkillRoots(scope: SkillScope): ReadonlySet<string> {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  return new Set(roots.map((r) => r.root));
}

/**
 * Is this root a place OK may offer to write, on THIS machine, right now?
 *
 * A standard host root qualifies once its activation path exists — the agent's
 * own dotdir for an agent-owned root, the whole root for a shared one like
 * `.github/skills` (see `skillRootActivationPath`). A root under a dotdir that
 * is not there belongs to a tool the user does not have, and offering it is
 * offering to CREATE that dotdir, which OK does not do.
 * Directory-based detection then reads what we created back as "installed", so
 * a single accepted offer manufactures its own evidence.
 *
 * Custom roots always qualify. A custom root exists only because a human typed
 * it into "Add custom path"; that declaration IS the consent, and gating it on
 * disk state would break the one escape hatch these surfaces have for wiring up
 * a folder before its tool arrives.
 *
 * Deliberately NOT folded into `knownSkillRootsFor`: cleanup paths
 * (`removableSkillOccurrenceDirs`, the reclaim sweeps) must keep seeing every
 * root, or a stray bundle under a since-removed dotdir becomes unreachable.
 * This gates what is OFFERED, never what is SEEN.
 */
export function isActivatedSkillRoot(base: string, scope: SkillScope, root: string): boolean {
  if (!standardSkillRoots(scope).has(root)) return true;
  return existsSync(join(base, skillRootActivationPath(root)));
}

/**
 * The `<root>/<name>` bundle dirs a cross-scope MOVE may remove from the source
 * scope — every occurrence that is THIS skill, and nothing else.
 *
 * A move relocated the bytes, so nothing of this skill may survive here. But
 * "same name" is not "same skill": the registry deliberately models two
 * same-named bundles with different content as two DISTINCT skills
 * (`conflictHosts`), and an uninstall protects them via the hash-guarded
 * `removeInPlaceSkillCopies`. A move must protect them too — deleting
 * `.cursor/skills/foo` because `.claude/skills/foo` moved away destroys a
 * bundle its owner never touched, unrecoverably when it is untracked.
 *
 * So: symlinks go (a projection of the moved tree, dangling or not), and a real
 * directory goes ONLY when its content hash matches the skill that moved.
 * Anything else is somebody else's skill and stays.
 *
 * Roots come from `knownSkillRootsFor` (host roots + recorded custom roots) plus
 * the legacy `.ok/skills` store, so a copy parked outside the standard roots
 * cannot survive to be re-detected as a second skill at the scope the user just
 * moved away from.
 */
export function removableSkillOccurrenceDirs(
  base: string,
  scope: SkillScope,
  name: string,
  /** Content hash of the bundle that moved; a real dir must match it to go. */
  contentHash: string,
): string[] {
  const roots = new Set<string>([
    ...knownSkillRootsFor(base, scope).map((r) => r.root),
    LEGACY_SKILL_STORE_ROOT,
  ]);
  const dirs: string[] = [];
  for (const root of roots) {
    const dir = join(base, root, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      // `lstat`, not `existsSync`: a projection whose target the move already
      // deleted is still a dir entry the next scan trips on.
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      dirs.push(dir);
      continue;
    }
    if (parseSkillDir(dir)?.contentHash === contentHash) dirs.push(dir);
  }
  return dirs;
}

/**
 * The SOURCE roots of the aliases `scanHostRootAliases` found — the paths that
 * are themselves symlinked folders (e.g. `.codex/skills` when it links to
 * `.agents/skills`). Placement records under these paths are receipts written
 * before the folder became an alias: the bytes physically live in the target
 * root, so listing them as custom placements would resurrect the aliased
 * folder as a fake location row (and invite writes through the alias).
 */
export function aliasedSourceRoots(
  aliases: Record<string, string>,
  scope: SkillScope,
): Set<string> {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  const byHost = new Map(roots.map((r) => [r.editor as string, r.root]));
  const out = new Set<string>();
  for (const host of Object.keys(aliases)) {
    const root = byHost.get(host);
    if (root !== undefined) out.add(root);
    // Custom-root aliases: the host id IS the root path.
    else if (host.includes('/')) out.add(host);
  }
  return out;
}

/**
 * The DEFAULT home for a NEW skill bundle at `base` — existence-activated:
 * `.agents/skills` only when the project already adopted the hub (OK never
 * creates `.agents` on its own — that's the team's call, not ours), else the
 * highest-precedence editor root that already exists. `null` means no host has
 * granted a usable location.
 */
export function resolveDefaultSkillHomeRel(base: string, scope: SkillScope): string | null {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  if (existsSync(join(base, '.agents'))) return AGENTS_SKILLS_ROOT;
  const byPrecedence = [...roots]
    .filter((r) => r.editor !== 'agents')
    .sort((a, b) => {
      const ra = SKILL_CANONICAL_PRECEDENCE.indexOf(a.editor);
      const rb = SKILL_CANONICAL_PRECEDENCE.indexOf(b.editor);
      return (
        (ra === -1 ? SKILL_CANONICAL_PRECEDENCE.length : ra) -
        (rb === -1 ? SKILL_CANONICAL_PRECEDENCE.length : rb)
      );
    });
  for (const { root } of byPrecedence) {
    if (existsSync(join(base, skillRootActivationPath(root)))) return root;
  }
  return null;
}

/**
 * The folders {@link resolveDefaultSkillHomeRel} would accept at `scope`, as the
 * activation paths a user actually creates (`.claude/`, `.agents/`, …). Lives
 * beside the resolver so a refusal message naming them cannot drift from the
 * set the resolver really consults when a new host is onboarded.
 */
export function skillHomeCandidateFolders(scope: SkillScope): string[] {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  return [...new Set(roots.map((r) => `${skillRootActivationPath(r.root)}/`))];
}

/**
 * Cheap change-stamp for a bundle dir: every file's relpath+size+mtime from a
 * stat-only walk (follows symlinks, so a linked bundle stamps its target). An
 * order of magnitude cheaper than reading + hashing the contents.
 */
function bundleStamp(absDir: string): string | null {
  const parts: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r);
      else parts.push(`${r}:${st.size}:${st.mtimeMs}`);
    }
  };
  try {
    walk(absDir, '');
  } catch {
    return null;
  }
  return parts.sort().join('|');
}

/** Stamp-keyed parse cache: the scan runs on every `/api/skills` AND after
 *  every install mutation, re-hashing every bundle (project + the user's whole
 *  `~/.claude/skills` at global tier) — the reported UI slowness. Unchanged
 *  bundles (stamp match) skip the content read entirely. Bounded in practice
 *  by the number of skill dirs on the machine. */
const parseCache = new Map<string, { stamp: string; contentHash: string; description: string }>();

function parseSkillDirCached(absDir: string): { contentHash: string; description: string } | null {
  const stamp = bundleStamp(absDir);
  if (stamp === null) return null;
  const hit = parseCache.get(absDir);
  if (hit !== undefined && hit.stamp === stamp) return hit;
  const parsed = parseSkillDir(absDir);
  if (!parsed) return null;
  const entry = { stamp, contentHash: parsed.contentHash, description: parsed.description };
  parseCache.set(absDir, entry);
  return entry;
}

function scanBase(base: string, scope: SkillScope): InPlaceSkill[] {
  const occurrences: ScanOccurrence[] = [];
  const sourcePrefs = readSourceHostPrefs(base);
  // Editor host roots + known custom roots for this scope — the SAME set the
  // Folders surface uses, so scan and folder verbs can't derive roots two ways.
  const allRoots = knownSkillRootsFor(base, scope);

  let baseReal: string | null = null;
  try {
    baseReal = realpathSync(base);
  } catch {
    baseReal = null;
  }
  for (const { editor, root } of allRoots) {
    const absRoot = join(base, root);
    let entries: string[];
    let rootAliased = false;
    try {
      if (!existsSync(absRoot)) continue;
      // An aliased root (the folder or a parent is a symlink) exposes VIEWS of
      // another location: its occurrences must never win election — a
      // canonical recorded at an alias path renders as an orphan location.
      rootAliased = baseReal !== null && realpathSync(absRoot) !== join(baseReal, root);
      entries = readdirSync(absRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absDir = join(absRoot, entry);
      try {
        if (!statSync(absDir).isDirectory()) continue; // follows links: a symlinked bundle counts
        const parsed = parseSkillDirCached(absDir);
        if (!parsed) continue; // no SKILL.md → not a skill bundle
        occurrences.push({
          // Dir basename is the projection identity (install copies keep it),
          // not the frontmatter name which is display-only.
          name: entry,
          scope,
          editor: editor as SkillHostId,
          contentHash: parsed.contentHash,
          dir: `${root}/${entry}`,
          description: parsed.description,
          viaLink: rootAliased || lstatSync(absDir).isSymbolicLink(),
          ...(rootAliased ? { aliasRooted: true } : {}),
          ...(sourcePrefs[entry] === editor ? { preferredSource: true } : {}),
        });
      } catch {
        // unreadable / vanished mid-scan — skip this bundle
      }
    }
  }

  const { admittedDirs, canonicalDir } = buildSkillRegistry(occurrences);
  // Where a host-LESS lookup of each name lands. Several distinct-content
  // bundles can share a name, so `.find(s => s.name === n)` is only safe if the
  // default sorts first — otherwise every by-name caller silently resolves in
  // content-hash order. Ordering it here fixes all of them at once.
  const byNameDefaults = new Set(canonicalDir.values());
  return (
    groupSkillsByIdentity(occurrences)
      .filter((g) => admittedDirs.has(g.canonical.dir))
      // Two same-named bundles are two skills only when the divergence is the
      // user's: a copy tracks its source until someone hand-edits it, and THAT is
      // what makes it its own thing. OK's own bundles have neither half — they are
      // read-only here and OK ships their bytes — so a projection that drifted
      // from the shipped one is a stale artifact, not a second skill. One row.
      .filter((g) => byNameDefaults.has(g.canonical.dir) || !isInternalBundleSkillName(g.name))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          Number(byNameDefaults.has(b.canonical.dir)) -
            Number(byNameDefaults.has(a.canonical.dir)) ||
          a.contentHash.localeCompare(b.contentHash),
      )
      .map((g) => {
        // Occurrences that are PHYSICALLY the canonical folder reached through a
        // parent-directory symlink (e.g. a sync tool making `.codex/skills` a
        // dir-link to `.agents/skills`): the leaf isn't a link, so it reads as a
        // real dir — but it's the SAME inode as the source, not an independent
        // copy. Disclose as VIA (loads through the source's folder); treating it
        // as a copy showed a false COPY tag the mode buttons could never change.
        let canonicalReal: string | null = null;
        try {
          canonicalReal = realpathSync(join(base, g.canonical.dir));
        } catch {
          canonicalReal = null;
        }
        const isSameInode = (dir: string): boolean => {
          if (canonicalReal === null) return false;
          try {
            return realpathSync(join(base, dir)) === canonicalReal;
          } catch {
            return false;
          }
        };
        const realCopies = g.copies.filter(
          (c) => c.aliasRooted !== true && (c.viaLink || !isSameInode(c.dir)),
        );
        const conflictHosts = occurrences
          .filter((o) => o.name === g.canonical.name && o.contentHash !== g.contentHash)
          .map((o) => o.editor);
        // `hosts` = PHYSICAL locations only (canonical + independent copies).
        // Alias-covered viewers are NOT locations — they surface as audience
        // icons via `scanHostRootAliases`, never as installed-location counts.
        return {
          name: g.canonical.name,
          description: g.canonical.description,
          dir: g.canonical.dir,
          hosts: [g.canonical.editor, ...realCopies.map((c) => c.editor)],
          linkedHosts: [g.canonical, ...realCopies].filter((o) => o.viaLink).map((o) => o.editor),
          conflictHosts,
          copyDirs: realCopies.filter((c) => !c.viaLink).map((c) => c.dir),
          contentHash: g.contentHash,
        };
      })
  );
}

/**
 * Scan `contentDir`'s editor host dirs for in-place skill bundles, dedup via the
 * registry, and return one entry per distinct-content skill (same-content copies
 * excluded). Missing dirs / unreadable bundles are skipped, never thrown.
 */
export function scanInPlaceSkills(contentDir: string): InPlaceSkill[] {
  return scanBase(contentDir, 'project');
}

/**
 * GLOBAL tier of the same scan: the user home's editor skill dirs
 * (`~/.claude/skills`, `~/.agents/skills`, `~/.pi/agent/skills`, …). `dir` is
 * home-relative. Callers exclude `~/.ok/skills` store names (store wins) and
 * OK's reserved built-ins.
 */
export function scanGlobalInPlaceSkills(home: string): InPlaceSkill[] {
  return scanBase(home, 'global');
}

/** User skill roots in canonical-precedence order (unlisted hosts last, stable). */
const USER_ROOTS_BY_PRECEDENCE = [...USER_SKILL_ROOTS].sort((a, b) => {
  const ra = SKILL_CANONICAL_PRECEDENCE.indexOf(a.editor);
  const rb = SKILL_CANONICAL_PRECEDENCE.indexOf(b.editor);
  const na = ra === -1 ? SKILL_CANONICAL_PRECEDENCE.length : ra;
  const nb = rb === -1 ? SKILL_CANONICAL_PRECEDENCE.length : rb;
  return na - nb || a.editor.localeCompare(b.editor);
});

/**
 * Resolve a GLOBAL skill name to its native bundle dir (absolute), or null.
 * A cheap precedence-ordered existence probe — the resolution twin of
 * `scanGlobalInPlaceSkills` for hot paths (`managedArtifactAbsPath`) that
 * can't afford a full hash scan. First existing dir in precedence order ==
 * the registry's by-name default dir, since both orders derive from
 * `SKILL_CANONICAL_PRECEDENCE`. When one name has several distinct-content
 * bundles this resolves the default one, same as any other host-less lookup.
 */
export function resolveGlobalNativeSkillDir(home: string, name: string): string | null {
  for (const { root } of USER_ROOTS_BY_PRECEDENCE) {
    const dir = join(home, root, name);
    try {
      if (existsSync(join(dir, 'SKILL.md'))) return dir;
    } catch {
      // unreadable root — skip
    }
  }
  return null;
}

/**
 * The contentDir-relative canonical bundle dirs to admit as content (the
 * `ContentFilter.inPlaceSkillDirs` allow-list).
 */
/**
 * Known skill ROOT paths for a project, contentDir-relative — every editor host
 * root plus the ledger's custom roots. The content filter uses this to exclude
 * non-canonical projections without hardcoding a host list of its own; sharing
 * `knownSkillRootsFor` with the scanner is what keeps a newly-supported host
 * (or a user's custom root) from silently leaking in as ordinary content.
 */
export function skillRootPathsFor(contentDir: string): ReadonlySet<string> {
  return new Set(knownSkillRootsFor(contentDir, 'project').map((r) => r.root));
}

export function scanInPlaceSkillDirs(contentDir: string): ReadonlySet<string> {
  return new Set(scanInPlaceSkills(contentDir).map((s) => s.dir));
}
