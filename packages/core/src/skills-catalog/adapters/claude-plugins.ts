import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { SkillProvenance } from '../schema.ts';
import {
  detectInert,
  type RawSkill,
  readSkillDir,
  type SkillBundle,
  skillDirNames,
} from './shared.ts';

function splitPluginKey(key: string): { plugin: string; marketplace?: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { plugin: key };
  return { plugin: key.slice(0, at), marketplace: key.slice(at + 1) };
}

interface PluginEntry {
  scope?: string;
  projectPath?: string;
  installPath?: string;
  version?: string;
  gitCommitSha?: string;
  lastUpdated?: string;
  orphaned_at?: string;
}

function activeEntries(
  entries: PluginEntry[],
  resolveDirInstall: (entry: PluginEntry) => string | null,
): PluginEntry[] {
  const bySite = new Map<string, PluginEntry>();
  for (const e of entries) {
    if (e.orphaned_at || !e.installPath) continue;
    let resolved = e;
    if (!existsSync(e.installPath)) {
      const dir = resolveDirInstall(e);
      if (dir === null) continue;
      resolved = { ...e, installPath: dir };
    }
    const site = `${resolved.scope ?? ''} ${resolved.projectPath ?? ''}`;
    const cur = bySite.get(site);
    if (!cur || (resolved.lastUpdated ?? '') > (cur.lastUpdated ?? '')) bySite.set(site, resolved);
  }
  return [...bySite.values()];
}

function readDirectoryMarketplaces(pluginsDir: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let registry: Record<
    string,
    { source?: { source?: string; path?: string }; installLocation?: string }
  >;
  try {
    registry = JSON.parse(readFileSync(join(pluginsDir, 'known_marketplaces.json'), 'utf-8'));
  } catch {
    return out;
  }
  for (const [name, entry] of Object.entries(registry ?? {})) {
    if (entry?.source?.source !== 'directory') continue;
    const dir = entry.source.path ?? entry.installLocation;
    if (typeof dir !== 'string' || dir.length === 0 || !isAbsolute(dir)) continue;
    try {
      const manifest = JSON.parse(
        readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf-8'),
      ) as { plugins?: { name?: string; source?: string }[] };
      const roots = new Map<string, string>();
      for (const p of manifest.plugins ?? []) {
        if (typeof p?.name !== 'string' || typeof p?.source !== 'string') continue;
        roots.set(p.name, resolve(dir, p.source));
      }
      if (roots.size > 0) out.set(name, roots);
    } catch {}
  }
  return out;
}

function readPluginJson(installPath: string): {
  description?: string;
  version?: string;
  author?: { name?: string };
} {
  const p = join(installPath, '.claude-plugin', 'plugin.json');
  try {
    const json = JSON.parse(readFileSync(p, 'utf-8'));
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

function readMarketplaceRepos(pluginsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = readFileSync(join(pluginsDir, 'known_marketplaces.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<
      string,
      { source?: { source?: string; repo?: string } }
    >;
    for (const [name, entry] of Object.entries(parsed ?? {})) {
      const source = entry?.source;
      if (source?.source === 'github' && typeof source.repo === 'string' && source.repo)
        out.set(name, `https://github.com/${source.repo}`);
    }
  } catch {}
  return out;
}

export function enumerateClaudePlugins(pluginsDir: string, harness: string): SkillBundle[] {
  const manifestPath = join(pluginsDir, 'installed_plugins.json');
  if (!existsSync(manifestPath)) return [];
  let manifest: { plugins?: Record<string, PluginEntry[]> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.warn(
      '[skills-catalog] failed to parse installed_plugins.json, skipping Claude plugins',
      { manifestPath, err },
    );
    return [];
  }
  const plugins = manifest?.plugins;
  if (!plugins || typeof plugins !== 'object') return [];
  const repoByMarketplace = readMarketplaceRepos(pluginsDir);
  const dirMarketplaces = readDirectoryMarketplaces(pluginsDir);

  const bundles: SkillBundle[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue;
    const { plugin, marketplace } = splitPluginKey(key);
    const resolveDirInstall = (_entry: PluginEntry): string | null => {
      const root = marketplace ? (dirMarketplaces.get(marketplace)?.get(plugin) ?? null) : null;
      return root !== null && existsSync(root) ? root : null;
    };
    for (const entry of activeEntries(entries, resolveDirInstall)) {
      const installPath = entry.installPath as string;
      const inert = detectInert(installPath);
      const meta = readPluginJson(installPath);
      const skillsRoot = join(installPath, 'skills');
      const skills: RawSkill[] = [];
      for (const name of skillDirNames(skillsRoot)) {
        const provenance: SkillProvenance = {
          plugin,
          ...(marketplace ? { marketplace } : {}),
          ...(entry.version ? { version: entry.version } : {}),
          ...(entry.gitCommitSha ? { gitCommitSha: entry.gitCommitSha } : {}),
          ...(entry.scope ? { scope: entry.scope } : {}),
          ...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
          ...(marketplace && repoByMarketplace.get(marketplace)
            ? { repositoryUrl: repoByMarketplace.get(marketplace) }
            : {}),
        };
        const skill = readSkillDir(join(skillsRoot, name), harness, provenance, inert);
        if (skill) skills.push(skill);
      }
      if (skills.length === 0) continue;
      bundles.push({
        packName: plugin,
        packVersion: entry.version ?? meta.version ?? '0.0.0',
        ...(typeof meta.description === 'string' ? { packDescription: meta.description } : {}),
        ...(typeof meta.author?.name === 'string' ? { packAuthor: meta.author.name } : {}),
        harness,
        skills,
      });
    }
  }
  return bundles;
}
