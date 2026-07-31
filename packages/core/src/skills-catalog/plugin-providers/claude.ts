import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { enumerateClaudePlugins } from '../adapters/claude-plugins.ts';
import type { PluginProviderAdapter } from './types.ts';

const CACHE_SOURCE = /^(.*\/plugins\/cache\/([^/]+)\/([^/]+))\/([^/]+)(?:\/.*)?$/;
const PLUGIN_PATH = /^(.*\/plugins)\/(?:cache|marketplaces)\/([^/]+)\//;
const MARKETPLACE_SOURCE = /^(.*\/plugins\/marketplaces\/([^/]+))(?:\/.*)?$/;

function normalizedPath(source: string): string {
  return source.replaceAll('\\', '/').replace(/\/+$/, '');
}

function marketplaceRepositoryUrl(source: string): string | null {
  const match = PLUGIN_PATH.exec(normalizedPath(source));
  if (!match) return null;
  try {
    const raw = readFileSync(`${match[1]}/known_marketplaces.json`, 'utf-8');
    const entry = (
      JSON.parse(raw) as Record<string, { source?: { source?: string; repo?: string } }>
    )[match[2]];
    return entry?.source?.source === 'github' && entry.source.repo
      ? `https://github.com/${entry.source.repo}`
      : null;
  } catch {
    return null;
  }
}

function readPluginManifest(
  source: string,
  boundary: string,
): { name: string; version?: string } | null {
  let current = resolve(source);
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    return null;
  }
  const stop = resolve(boundary);
  while (current === stop || current.startsWith(`${stop}/`)) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(current, '.claude-plugin', 'plugin.json'), 'utf-8'),
      ) as { name?: unknown; version?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) {
        return {
          name: parsed.name,
          ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
        };
      }
    } catch {
      // Keep walking toward the marketplace root.
    }
    if (current === stop) break;
    current = dirname(current);
  }
  return null;
}

function inspectSource(source: string): ReturnType<PluginProviderAdapter['inspectSource']> {
  const normalized = normalizedPath(source);
  const cache = CACHE_SOURCE.exec(normalized);
  if (cache) {
    const manifest = readPluginManifest(source, `${cache[1]}/${cache[4]}`);
    if (!manifest || manifest.name !== cache[3]) return null;
    return {
      plugin: cache[3],
      marketplace: cache[2],
      version: manifest.version ?? cache[4],
    };
  }

  const marketplace = MARKETPLACE_SOURCE.exec(normalized);
  if (!marketplace) return null;
  const manifest = readPluginManifest(source, marketplace[1]);
  if (!manifest) return null;
  return {
    plugin: manifest.name,
    marketplace: marketplace[2],
    ...(manifest.version ? { version: manifest.version } : {}),
  };
}

function newestVersion(versions: string[]): string | undefined {
  return [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
}

function resolveUpdateSource(source: string): string {
  const normalized = normalizedPath(source);
  const match = CACHE_SOURCE.exec(normalized);
  if (!match) return source;
  const [pluginRoot, recordedVersion] = [match[1], match[4]];
  const suffix = normalized.slice(
    match[0].indexOf(`/${recordedVersion}`) + recordedVersion.length + 1,
  );
  let versions: string[];
  try {
    versions = readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return source;
  }
  const latest = newestVersion(versions);
  if (latest === undefined || latest === recordedVersion) return source;
  const candidate = `${pluginRoot}/${latest}${suffix}`;
  return existsSync(candidate) ? candidate : source;
}

/**
 * Read a manifest's `{name, version, description}` from the first path that
 * parses. Shared by the plugin.json-lineage providers (Claude/Codex/Copilot);
 * their only difference is WHERE the manifest lives, passed as `relPaths`.
 */
export function readManifestIdentity(
  dir: string,
  relPaths: readonly string[],
): { plugin: string; version?: string; description?: string } | null {
  for (const rel of relPaths) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, rel), 'utf-8')) as {
        name?: unknown;
        version?: unknown;
        description?: unknown;
      };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) {
        return {
          plugin: parsed.name,
          ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
          ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
        };
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

/**
 * A cloned repo is a Claude plugin when it carries `.claude-plugin/plugin.json`
 * OR a `.claude-plugin/marketplace.json` (single-plugin marketplace at `./`).
 * Setup IS supported — OK owns the Claude plugin install lifecycle.
 */
function detectDir(dir: string): ReturnType<PluginProviderAdapter['detectDir']> {
  const plugin = readManifestIdentity(dir, ['.claude-plugin/plugin.json']);
  if (plugin) return { ...plugin, setupSupported: true };
  // marketplace.json lists plugins; a single `./`-sourced plugin is the common
  // repo-is-one-plugin case (e.g. ponytail). Read its name/description.
  try {
    const mkt = JSON.parse(
      readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    ) as {
      name?: unknown;
      plugins?: Array<{ name?: unknown; description?: unknown; source?: unknown }>;
    };
    const self = mkt.plugins?.find((p) => p.source === './') ?? mkt.plugins?.[0];
    const name = typeof self?.name === 'string' ? self.name : mkt.name;
    if (typeof name === 'string' && name.length > 0) {
      return {
        plugin: name,
        ...(typeof self?.description === 'string' ? { description: self.description } : {}),
        setupSupported: true,
      };
    }
  } catch {
    // Not a Claude plugin repo.
  }
  return null;
}

export const claudePluginProvider: PluginProviderAdapter = {
  id: 'claude',
  homes: (home) => [{ harness: 'claude', dir: join(home, '.claude', 'plugins') }],
  enumerate: enumerateClaudePlugins,
  inspectSource,
  repositoryUrl: marketplaceRepositoryUrl,
  resolveUpdateSource,
  detectDir,
};
