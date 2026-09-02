import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { manifestRepositoryUrl } from './plugin-providers/manifest-providers.ts';

export interface RepoMarketplacePlugin {
  readonly name: string;
  readonly marketplace: string;
  readonly rootReal: string;
  readonly url?: string;
}

export function readRepoMarketplacePlugins(contentDir: string): RepoMarketplacePlugin[] {
  let manifest: { name?: unknown; plugins?: Array<{ name?: unknown; source?: unknown }> };
  try {
    manifest = JSON.parse(
      readFileSync(join(contentDir, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    );
  } catch (err) {
    warnUnlessMissing(err, 'failed to read repo marketplace manifest, skipping', contentDir);
    return [];
  }
  if (typeof manifest?.name !== 'string' || !Array.isArray(manifest.plugins)) return [];
  let contentReal: string;
  try {
    contentReal = realpathSync(contentDir);
  } catch (err) {
    warnUnlessMissing(err, 'failed to resolve the content dir, skipping repo plugins', contentDir);
    return [];
  }
  const enabled = readEnabledPlugins(contentDir);
  const out: RepoMarketplacePlugin[] = [];
  for (const p of manifest.plugins) {
    if (typeof p?.name !== 'string' || typeof p?.source !== 'string') continue;
    if (isAbsolute(p.source) || /^[a-z]+:/i.test(p.source)) continue;
    if (enabled[`${p.name}@${manifest.name}`] !== true) continue;
    let rootReal: string;
    try {
      rootReal = realpathSync(resolve(contentDir, p.source));
    } catch (err) {
      warnUnlessMissing(err, `failed to resolve plugin root for ${p.name}, skipping`, contentDir);
      continue;
    }
    if (!rootReal.startsWith(`${contentReal}${sep}`)) continue;
    const url = manifestRepositoryUrl(rootReal, '.claude-plugin/plugin.json');
    out.push({ name: p.name, marketplace: manifest.name, rootReal, ...(url ? { url } : {}) });
  }
  return out;
}

function warnUnlessMissing(err: unknown, msg: string, contentDir: string): void {
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
  console.warn(`[skills-catalog] ${msg}`, { contentDir, err });
}

function readEnabledPlugins(contentDir: string): Record<string, unknown> {
  try {
    const settings = JSON.parse(
      readFileSync(join(contentDir, '.claude', 'settings.json'), 'utf-8'),
    ) as { enabledPlugins?: unknown };
    const e = settings.enabledPlugins;
    return e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
  } catch (err) {
    warnUnlessMissing(
      err,
      'failed to read .claude/settings.json, no repo plugins enabled',
      contentDir,
    );
    return {};
  }
}

export function repoMarketplacePluginFor(
  plugins: readonly RepoMarketplacePlugin[],
  skillAbsDir: string,
): RepoMarketplacePlugin | null {
  if (plugins.length === 0) return null;
  let real: string;
  try {
    real = realpathSync(skillAbsDir);
  } catch (err) {
    warnUnlessMissing(err, 'failed to resolve skill dir', skillAbsDir);
    return null;
  }
  return plugins.find((p) => real.startsWith(`${p.rootReal}${sep}skills${sep}`)) ?? null;
}
