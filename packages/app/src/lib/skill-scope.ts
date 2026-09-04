import {
  AGENTS_SKILLS_ROOT,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  PACK_SKILL_PREFIX,
  type SkillScope,
  type SkillsListEntry,
  SkillUserTargetEditorSchema,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';

export function customPlacementRoot(placement: { path: string }): string {
  return placement.path.split('/').slice(0, -1).join('/');
}

export const SKILL_SCOPE_ORDER: readonly SkillScope[] = ['project', 'global'] as const;

export function skillNameSetsByScope(
  skills: readonly SkillsListEntry[],
): Record<SkillScope, Set<string>> {
  return {
    project: new Set(skills.filter((s) => s.scope === 'project').map((s) => s.name)),
    global: new Set(skills.filter((s) => s.scope === 'global').map((s) => s.name)),
  };
}

export function skillDisplayName(name: string): string {
  return name.startsWith(PACK_SKILL_PREFIX) ? name.slice(PACK_SKILL_PREFIX.length) : name;
}

function skillEntryDir(skill: Pick<SkillsListEntry, 'scope' | 'path'>): string {
  const dir = skill.path.replace(/\/SKILL\.mdx?$/i, '');
  return skill.scope === 'global' ? `~/${dir}` : dir;
}

export function tildeHomePath(abs: string): string {
  return abs.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^\/root/, '~');
}

export function skillDir(skillMdPath: string): string {
  const i = skillMdPath.lastIndexOf('/');
  return i > 0 ? skillMdPath.slice(0, i) : skillMdPath;
}

export function useSkillScopeLabels(): Record<SkillScope, string> {
  const { t } = useLingui();
  return { project: t`Project`, global: t`Global` };
}

export function useSkillScopeDescriptions(): Record<SkillScope, string> {
  const { t } = useLingui();
  return {
    project: t`Lives in this project (wherever the skill's folder is) and is shared with collaborators through git.`,
    global: t`Available in every project on this machine. Not shared through git.`,
  };
}

const PLUGIN_PROVIDER_RE = /\/\.([a-z][a-z-]*)\/plugins\/(?:cache|marketplaces)\/[^/]+\/([^/]+)\//;
export function pluginCoverageOf(
  skill: (Pick<SkillsListEntry, 'plugin' | 'origin'> & Partial<SkillsListEntry>) | undefined,
): { editor: string; plugin: string } | null {
  if (skill?.plugin) return { editor: skill.plugin.provider, plugin: skill.plugin.name };
  const source = skill?.origin?.source;
  if (!source) return null;
  const m = PLUGIN_PROVIDER_RE.exec(source);
  if (!m) return null;
  const [, provider, plugin] = m;
  if (!provider || !plugin) return null;
  return { editor: provider, plugin };
}

export function skillHostRootDir(host: string, scope: SkillScope): string {
  if (host.includes('/')) return scope === 'global' ? `~/${host}` : host;
  const map = scope === 'global' ? EDITOR_USER_SKILL_ROOT : EDITOR_PROJECT_SKILL_ROOT;
  const rel =
    host === 'agents'
      ? AGENTS_SKILLS_ROOT
      : ((map as Record<string, string | null>)[host] ?? `.${host}/skills`);
  return scope === 'global' ? `~/${rel}` : rel;
}

export function aliasSubscribersOf(
  aliases: Record<string, string> | undefined,
  rootRel: string,
): string[] {
  if (!aliases || rootRel === '') return [];
  return Object.keys(aliases).filter((h) => aliases[h] === rootRel);
}

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
  push(skillEntryDir(skill), linked.has(skill.hosts[0] ?? ''));
  for (const h of skill.hosts) {
    push(`${skillHostRootDir(h, skill.scope)}/${skill.name}`, linked.has(h));
  }
  for (const cp of skill.customPlacements ?? []) {
    push(cp.path, cp.mode === 'link');
  }
  return out;
}

export function skillClusterHosts(
  skill: SkillsListEntry,
  hosts: readonly string[] = skill.hosts,
): string[] {
  const editors: readonly string[] = SkillUserTargetEditorSchema.options;
  const viewers = skillAliasViewers(skill);
  const pluginProvider = pluginCoverageOf(skill)?.editor;
  return [
    ...(hosts.includes('agents') ? ['agents'] : []),
    ...editors.filter((e) => hosts.includes(e) || viewers.includes(e) || e === pluginProvider),
    ...(skill.customPlacements ?? []).map((cp) => customPlacementRoot(cp)),
  ];
}
