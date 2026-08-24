import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { manifestRepositoryUrl } from './plugin-providers/manifest-providers.ts';

/** A plugin the open repo itself declares, resolved to its on-disk root. */
export interface RepoMarketplacePlugin {
  readonly name: string;
  readonly marketplace: string;
  /** Realpath of the plugin's root dir; skills live at `<root>/skills/<name>`. */
  readonly rootReal: string;
  readonly url?: string;
}

/**
 * Plugins declared by the open tree's own `.claude-plugin/marketplace.json`.
 *
 * A repo that hosts its marketplace serves these plugins in place, so a skill
 * under one of their roots IS the plugin's skill regardless of whether the
 * user's harness registry knows about this checkout. The registry is keyed by
 * absolute path: a second clone of the same repo has no entries there, the
 * identity join through `enumerateInstalledSkills` comes up empty, and every
 * in-repo plugin skill read as hand-authored. The manifest is the authority the
 * registry was only echoing, so read it directly.
 *
 * Only relative (in-tree) `source` entries count; a marketplace entry pointing
 * at a remote or absolute source is not served from this tree. And only plugins
 * the repo ENABLES count: the identity feeds a "Claude already loads this via
 * the plugin" claim downstream, and declaring a plugin does not make a harness
 * load it — `.claude/settings.json` `enabledPlugins` does.
 */
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
      // ENOENT is the phantom case (uninitialized submodule, mid-rename) and stays quiet.
      warnUnlessMissing(err, `failed to resolve plugin root for ${p.name}, skipping`, contentDir);
      continue;
    }
    // A relative source can still climb out (`../sibling`); that dir is not this tree's.
    if (!rootReal.startsWith(`${contentReal}${sep}`)) continue;
    // No plugin.json is fine: the marketplace entry alone is enough for identity.
    const url = manifestRepositoryUrl(rootReal, '.claude-plugin/plugin.json');
    out.push({ name: p.name, marketplace: manifest.name, rootReal, ...(url ? { url } : {}) });
  }
  return out;
}

/** An absent file is the common case and stays silent; a malformed or unreadable
 *  one silently zeroes out every repo plugin, so it gets a warning an operator can
 *  tell apart from "nothing declared" (same posture as the enumerator). */
function warnUnlessMissing(err: unknown, msg: string, contentDir: string): void {
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
  console.warn(`[skills-catalog] ${msg}`, { contentDir, err });
}

/** `enabledPlugins` from the repo's shared `.claude/settings.json`; `{}` when absent or unreadable. */
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

/** The repo-declared plugin whose `skills/` dir holds `skillAbsDir` (symlinks resolved), or null. */
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
