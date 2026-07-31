/**
 * Claude plugin adapter — the one provenance-carrying harness source.
 *
 * Source of truth is `installed_plugins.json` (version 2), NOT a `cache/**`
 * glob: the cache holds GC'd duplicate versions; the manifest names the ACTIVE
 * one and carries provenance (version, gitCommitSha, scope, marketplace). For
 * each `<plugin>@<marketplace>` key, entries are per `(scope, projectPath)`
 * install site; we pick the newest `lastUpdated` per site and skip any entry
 * that is `.orphaned_at` or missing its `installPath`.
 *
 * Read-only. The Claude plugin cache is the ONE store OK must never write —
 * this only reads it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillProvenance } from '../schema.ts';
import {
  detectInert,
  type RawSkill,
  readSkillDir,
  type SkillBundle,
  skillDirNames,
} from './shared.ts';

/** Split a `<plugin>@<marketplace>` key; marketplace omitted → undefined. */
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

/** Pick the active entry per `(scope, projectPath)`: newest `lastUpdated`, never orphaned. */
function activeEntries(entries: PluginEntry[]): PluginEntry[] {
  const bySite = new Map<string, PluginEntry>();
  for (const e of entries) {
    if (e.orphaned_at || !e.installPath || !existsSync(e.installPath)) continue;
    const site = `${e.scope ?? ''} ${e.projectPath ?? ''}`;
    const cur = bySite.get(site);
    if (!cur || (e.lastUpdated ?? '') > (cur.lastUpdated ?? '')) bySite.set(site, e);
  }
  return [...bySite.values()];
}

/** Read `<installPath>/.claude-plugin/plugin.json`; `{}` on absence/parse error. */
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

/**
 * Enumerate installed Claude plugins as skill bundles. `pluginsDir` is the
 * `~/.claude/plugins` directory. Returns `[]` when `installed_plugins.json` is
 * absent or malformed.
 */
export function enumerateClaudePlugins(pluginsDir: string, harness: string): SkillBundle[] {
  const manifestPath = join(pluginsDir, 'installed_plugins.json');
  if (!existsSync(manifestPath)) return [];
  let manifest: { plugins?: Record<string, PluginEntry[]> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    // A malformed manifest (e.g. a partial write mid-Claude-upgrade) erases
    // every provenance-carrying skill; log so that's distinguishable from "none".
    console.warn(
      '[skills-catalog] failed to parse installed_plugins.json, skipping Claude plugins',
      { manifestPath, err },
    );
    return [];
  }
  const plugins = manifest?.plugins;
  if (!plugins || typeof plugins !== 'object') return [];

  const bundles: SkillBundle[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue;
    const { plugin, marketplace } = splitPluginKey(key);
    for (const entry of activeEntries(entries)) {
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
          // The project a `project`-scoped install is bound to — the catalog is
          // machine-global, so this is how a detected skill is attributed to the
          // project that installed it (project-locality; see core `scope.ts`).
          ...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
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
