import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SkillProvenance } from '../schema.ts';
import { isDetectedSkillInProject } from '../scope.ts';
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

function readDirectoryMarketplaceLocations(pluginsDir: string): Map<string, string> {
  const out = new Map<string, string>();
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
    out.set(name, dir);
  }
  return out;
}

interface DirectoryMarketplace {
  directory: string;
  canonicalDirectory: string;
  pluginRoot?: string;
  plugins: Array<{ name?: unknown; source?: unknown }>;
  resolvedRoots: Map<string, string | null>;
}

function readDirectoryMarketplace(dir: string): DirectoryMarketplace | null {
  let manifest: { metadata?: { pluginRoot?: unknown }; plugins?: unknown };
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    );
    manifest = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('[skills-catalog] failed to read directory marketplace manifest', {
      marketplaceDir: dir,
      cause: boundedCause(err),
    });
    return null;
  }
  const pluginRoot =
    typeof manifest.metadata?.pluginRoot === 'string' ? manifest.metadata.pluginRoot : undefined;
  let canonicalDirectory: string;
  try {
    canonicalDirectory = realpathSync(dir);
  } catch (err) {
    console.warn('[skills-catalog] failed to resolve directory marketplace', {
      marketplaceDir: dir,
      cause: boundedCause(err),
    });
    return null;
  }
  return {
    directory: dir,
    canonicalDirectory,
    ...(pluginRoot === undefined ? {} : { pluginRoot }),
    plugins: Array.isArray(manifest.plugins) ? manifest.plugins : [],
    resolvedRoots: new Map(),
  };
}

function resolveDirectoryMarketplaceRoot(
  marketplace: DirectoryMarketplace,
  plugin: string,
): string | null {
  if (marketplace.resolvedRoots.has(plugin)) {
    return marketplace.resolvedRoots.get(plugin) ?? null;
  }
  let selected: { name?: unknown; source?: unknown } | undefined;
  for (const candidate of marketplace.plugins) {
    if (candidate?.name === plugin) selected = candidate;
  }
  if (typeof selected?.source !== 'string') {
    return rejectDirectoryMarketplaceSource(marketplace, plugin, 'missing or invalid source');
  }
  const source = selected.source;
  const sourceIsExplicitRelative = source.startsWith('./') && !source.includes('\\');
  const sourceIsBare =
    source.length > 0 && source !== '.' && source !== '..' && !/[\\/]/.test(source);
  if (!sourceIsExplicitRelative && !sourceIsBare) {
    return rejectDirectoryMarketplaceSource(marketplace, plugin, 'unsupported source form');
  }
  let base = marketplace.directory;
  if (sourceIsBare) {
    const pluginRoot = marketplace.pluginRoot;
    if (pluginRoot === undefined) {
      return rejectDirectoryMarketplaceSource(
        marketplace,
        plugin,
        'metadata.pluginRoot is required for a bare source',
      );
    }
    const resolvedPluginRoot = resolve(marketplace.directory, pluginRoot);
    const pluginRootFromMarketplace = relative(marketplace.directory, resolvedPluginRoot);
    if (
      isAbsolute(pluginRoot) ||
      pluginRootFromMarketplace === '..' ||
      pluginRootFromMarketplace.startsWith(`..${sep}`) ||
      isAbsolute(pluginRootFromMarketplace)
    ) {
      return rejectDirectoryMarketplaceSource(
        marketplace,
        plugin,
        'metadata.pluginRoot must be a relative path inside the marketplace',
      );
    }
    base = resolvedPluginRoot;
  }
  const root = resolve(base, source);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch (err) {
    return rejectDirectoryMarketplaceSource(marketplace, plugin, boundedCause(err));
  }
  const fromMarketplace = relative(marketplace.canonicalDirectory, canonicalRoot);
  if (
    fromMarketplace === '..' ||
    fromMarketplace.startsWith(`..${sep}`) ||
    isAbsolute(fromMarketplace)
  ) {
    return rejectDirectoryMarketplaceSource(
      marketplace,
      plugin,
      'source resolves outside marketplace',
    );
  }
  marketplace.resolvedRoots.set(plugin, root);
  return root;
}

function rejectDirectoryMarketplaceSource(
  marketplace: DirectoryMarketplace,
  plugin: string,
  cause: string,
): null {
  console.warn('[skills-catalog] rejected directory marketplace plugin source', {
    marketplaceDir: marketplace.directory,
    plugin,
    cause,
  });
  marketplace.resolvedRoots.set(plugin, null);
  return null;
}

function boundedCause(err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err);
  return cause.slice(0, 500);
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

export function enumerateClaudePlugins(
  pluginsDir: string,
  harness: string,
  projectDir?: string,
): SkillBundle[] {
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
  const dirMarketplaceLocations = readDirectoryMarketplaceLocations(pluginsDir);
  const dirMarketplaces = new Map<string, DirectoryMarketplace | null>();

  const bundles: SkillBundle[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue;
    const { plugin, marketplace } = splitPluginKey(key);
    const selectedEntries =
      projectDir === undefined
        ? entries
        : entries.filter((entry) =>
            isDetectedSkillInProject(
              { scope: entry.scope, projectPath: entry.projectPath },
              projectDir,
            ),
          );
    const resolveDirInstall = (_entry: PluginEntry): string | null => {
      if (!marketplace) return null;
      const location = dirMarketplaceLocations.get(marketplace);
      if (location === undefined) return null;
      if (!dirMarketplaces.has(marketplace)) {
        dirMarketplaces.set(marketplace, readDirectoryMarketplace(location));
      }
      const directoryMarketplace = dirMarketplaces.get(marketplace);
      if (directoryMarketplace == null) return null;
      const root = resolveDirectoryMarketplaceRoot(directoryMarketplace, plugin);
      return root !== null && existsSync(root) ? root : null;
    };
    for (const entry of activeEntries(selectedEntries, resolveDirInstall)) {
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
