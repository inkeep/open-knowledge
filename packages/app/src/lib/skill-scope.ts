import {
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  PACK_SKILL_PREFIX,
  type SkillScope,
  type SkillsListEntry,
  SkillTargetEditorSchema,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';

/**
 * The root a custom placement sits under — its path minus the skill's own dir.
 * Derived inline at four call sites before this; one spelling means a change to
 * the placement path shape cannot miss one of them.
 */
export function customPlacementRoot(placement: { path: string }): string {
  return placement.path.split('/').slice(0, -1).join('/');
}

/** Scope render order — project above global (this KB's own skills first).
 *  Shared by the Settings skills list and the sidebar Skills section. */
export const SKILL_SCOPE_ORDER: readonly SkillScope[] = ['project', 'global'] as const;

/**
 * Per-scope sets of existing skill names, used for create-dialog collision
 * validation. One source so the Settings list and the sidebar "+" agree.
 */
export function skillNameSetsByScope(
  skills: readonly SkillsListEntry[],
): Record<SkillScope, Set<string>> {
  return {
    project: new Set(skills.filter((s) => s.scope === 'project').map((s) => s.name)),
    global: new Set(skills.filter((s) => s.scope === 'global').map((s) => s.name)),
  };
}

/**
 * Browse-surface display name for a skill: drops the shared
 * `open-knowledge-pack-` prefix so e.g. `open-knowledge-pack-software-lifecycle`
 * (the longest shipped default) reads as `software-lifecycle` and fits a normal
 * sidebar width. DISPLAY-ONLY — the full name stays the identity (rename field,
 * doc path, tooltips); user-authored skills (no prefix) are unchanged.
 */
export function skillDisplayName(name: string): string {
  return name.startsWith(PACK_SKILL_PREFIX) ? name.slice(PACK_SKILL_PREFIX.length) : name;
}

/**
 * The user-visible on-disk dir of an EXISTING skill entry — derived from its
 * REAL `path`: an in-place skill lives at `.claude/skills/<name>`
 * (etc.), a store skill at `.ok/skills/<name>`. Global entry paths are
 * home-relative, so they render `~/`-prefixed.
 */
function skillEntryDir(skill: Pick<SkillsListEntry, 'scope' | 'path'>): string {
  const dir = skill.path.replace(/\/SKILL\.mdx?$/i, '');
  return skill.scope === 'global' ? `~/${dir}` : dir;
}

/**
 * Collapse a leading home directory to `~` for display (best-effort, cross-
 * platform: `/Users/<u>`, `/home/<u>`, `/root`). Used for a BUILT-IN skill's real
 * projected path (e.g. `~/.claude/skills/open-knowledge`), which — unlike an
 * authored skill — isn't in the `.ok/skills` store so can't be derived.
 */
export function tildeHomePath(abs: string): string {
  return abs.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^\/root/, '~');
}

/**
 * Short level titles shared by every skills surface. The `global` scope is
 * user-level (available in every project); `project` skills live in this KB
 * (in an editor dir or `.ok/skills`), shared via git. User-facing copy drops
 * the word "scope" entirely.
 */
export function useSkillScopeLabels(): Record<SkillScope, string> {
  const { t } = useLingui();
  return { project: t`Project`, global: t`Global` };
}

/**
 * One-line explanation of each level, for a tooltip on the scope header. Says
 * WHERE the skill lives and WHO sees it — the two things that distinguish the
 * levels.
 */
export function useSkillScopeDescriptions(): Record<SkillScope, string> {
  const { t } = useLingui();
  return {
    project: t`Lives in this project (wherever the skill's folder is) and is shared with collaborators through git.`,
    global: t`Available in every project on this machine. Not shared through git.`,
  };
}

/**
 * The on-disk skills ROOT dir for a skill host at a scope — the `.agents` hub
 * or an editor's primary dir, `~/`-prefixed at global scope. Path-first label
 * shared by the install menu, the row hover, and the icon-cluster tooltip, so
 * every surface names the same real directory instead of a brand name.
 */
export function skillHostRootDir(host: string, scope: SkillScope): string {
  // A custom-root host id IS its base-relative path (they contain '/') —
  // templating it as `.<id>/skills` would mangle it (`.tim/skills` →
  // `..tim/skills/skills`).
  if (host.includes('/')) return scope === 'global' ? `~/${host}` : host;
  const map = scope === 'global' ? EDITOR_USER_SKILL_ROOT : EDITOR_PROJECT_SKILL_ROOT;
  const rel =
    host === 'agents'
      ? '.agents/skills'
      : ((map as Record<string, string | null>)[host] ?? `.${host}/skills`);
  return scope === 'global' ? `~/${rel}` : rel;
}

/**
 * Alias-derived audience helpers: `hostAliases`
 * maps a host whose skills folder is a symlink → the base-relative root it
 * resolves into. One derivation shared by the install menu (audience icons on
 * rows, reach confirm) and the toolbar pill (viewer marks) so the two surfaces
 * can never disagree about who reads what.
 */
export function aliasSubscribersOf(
  aliases: Record<string, string> | undefined,
  rootRel: string,
): string[] {
  if (!aliases || rootRel === '') return [];
  return Object.keys(aliases).filter((h) => aliases[h] === rootRel);
}

/**
 * Alias-covered VIEWERS of a skill entry: hosts whose folder resolves into a
 * root that actually holds this skill (canonical, an editor occurrence, or a
 * custom placement). They read the skill without owning a location.
 */
function skillAliasViewers(
  entry: Pick<SkillsListEntry, 'scope' | 'path' | 'hosts' | 'hostAliases' | 'customPlacements'>,
): string[] {
  const aliases = entry.hostAliases ?? {};
  const rootOf = (p: string): string => p.split('/').slice(0, -1).join('/');
  const hostSet = new Set(entry.hosts);
  const occupiedRoots = new Set<string>([
    ...entry.hosts
      .filter((h) => !h.includes('/'))
      .map((h) => skillHostRootDir(h, entry.scope).replace(/^~\//, '')),
    ...(entry.customPlacements ?? []).map((cp) => rootOf(cp.path)),
    ...(entry.path.includes('/') ? [rootOf(entry.path.replace(/\/SKILL\.mdx?$/i, ''))] : []),
  ]);
  return Object.entries(aliases)
    .filter(([h, target]) => !hostSet.has(h) && occupiedRoots.has(target))
    .map(([h]) => h);
}

/**
 * Every on-disk path a skill entry occupies: its canonical dir (from the real
 * `path`) plus each host's `<hostRoot>/<name>` occurrence, deduped, canonical
 * first. `symlink` marks hosts whose occurrence is a user link (preserved,
 * and disclosed rather than presented as a plain copy).
 */
export function skillEntryDirs(
  skill: Pick<
    SkillsListEntry,
    'scope' | 'name' | 'path' | 'hosts' | 'symlinkedHosts' | 'customPlacements'
  >,
): Array<{ dir: string; symlink: boolean }> {
  const linked = new Set(skill.symlinkedHosts ?? []);
  const out: Array<{ dir: string; symlink: boolean }> = [];
  const seen = new Set<string>();
  const push = (dir: string, symlink: boolean) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    out.push({ dir, symlink });
  };
  // The canonical's own host is the FIRST hosts member (scan order), so its
  // link-ness applies to the canonical path too.
  push(skillEntryDir(skill), linked.has(skill.hosts[0] ?? ''));
  for (const h of skill.hosts) {
    push(`${skillHostRootDir(h, skill.scope)}/${skill.name}`, linked.has(h));
  }
  for (const cp of skill.customPlacements ?? []) {
    push(cp.path, cp.mode === 'link');
  }
  return out;
}

/**
 * Every location mark a skill's row or pill shows: the vendor-neutral hub, the
 * editors holding it, editors that read it through a folder alias, and its
 * custom-root placements.
 *
 * ONE derivation for all three surfaces. The sidebar row used to rebuild this
 * inline and omit `customPlacements` — so a skill placed only at a custom root
 * read "Install" in the sidebar and "Installed" in the toolbar at the same
 * moment, for the same skill. `hosts` is overridable so a surface holding an
 * optimistic overlay can pass its pending set instead of the server's.
 */
export function skillClusterHosts(
  skill: SkillsListEntry,
  hosts: readonly string[] = skill.hosts,
): string[] {
  const editors: readonly string[] = SkillTargetEditorSchema.options;
  const viewers = skillAliasViewers(skill);
  return [
    ...(hosts.includes('agents') ? ['agents'] : []),
    ...editors.filter((e) => hosts.includes(e) || viewers.includes(e)),
    ...(skill.customPlacements ?? []).map((cp) => customPlacementRoot(cp)),
  ];
}
