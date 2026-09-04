import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectInert, readSkillDir, type SkillBundle, skillDirNames } from '../adapters/shared.ts';
import { readManifestIdentity } from './claude.ts';
import type { PluginProviderAdapter } from './types.ts';

function manifestDetectionProvider(
  id: string,
  manifestPaths: readonly string[],
): PluginProviderAdapter {
  return {
    id,
    homes: () => [],
    enumerate: () => [],
    inspectSource: () => null,
    repositoryUrl: () => null,
    resolveUpdateSource: (source) => source,
    detectDir: (dir) => {
      const manifest = readManifestIdentity(dir, manifestPaths);
      return manifest ? { ...manifest, setupSupported: false } : null;
    },
  };
}

function manifestDeclaresSkills(dir: string, rel: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, rel), 'utf-8')) as { skills?: unknown };
    return parsed.skills !== undefined;
  } catch {
    return false;
  }
}

const AGENT_PLUGINS_SCHEMA_HOST = 'agent-plugins.org';
function declaresAgentPluginsSchema(dir: string, rel: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, rel), 'utf-8')) as { $schema?: unknown };
    return typeof parsed.$schema === 'string' && parsed.$schema.includes(AGENT_PLUGINS_SCHEMA_HOST);
  } catch {
    return false;
  }
}
const AGENT_PLUGIN_NAME_RE = /^(?!.*[-.]{2})[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function enumerateAgentPluginsRoot(
  pluginsRoot: string,
  harness: string,
  stamp: { readonly scope: 'user' | 'project'; readonly projectPath?: string },
): SkillBundle[] {
  let children: string[];
  try {
    children = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const bundles: SkillBundle[] = [];
  for (const child of children) {
    const dir = join(pluginsRoot, child);
    if (!declaresAgentPluginsSchema(dir, 'plugin.json')) continue;
    const identity = readManifestIdentity(dir, ['plugin.json']);
    if (!identity || !AGENT_PLUGIN_NAME_RE.test(identity.plugin)) continue;
    const repositoryUrl = manifestRepositoryUrl(dir, 'plugin.json');
    const inert = detectInert(dir);
    const skills = skillDirNames(join(dir, 'skills'))
      .map((name) =>
        readSkillDir(
          join(dir, 'skills', name),
          harness,
          {
            pluginProvider: 'agent-plugins',
            plugin: identity.plugin,
            ...(identity.version !== undefined ? { version: identity.version } : {}),
            ...(repositoryUrl !== null ? { repositoryUrl } : {}),
            scope: stamp.scope,
            ...(stamp.projectPath !== undefined ? { projectPath: stamp.projectPath } : {}),
          },
          inert,
        ),
      )
      .filter((skill) => skill !== null);
    if (skills.length === 0) continue;
    bundles.push({
      packName: identity.plugin,
      packVersion: identity.version ?? '0.0.0',
      ...(identity.description !== undefined ? { packDescription: identity.description } : {}),
      harness,
      skills,
    });
  }
  return bundles;
}

export function manifestRepositoryUrl(dir: string, rel: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, rel), 'utf-8')) as { repository?: unknown };
    return typeof parsed.repository === 'string' && parsed.repository.length > 0
      ? parsed.repository
      : null;
  } catch {
    return null;
  }
}

export const agentPluginsProvider: PluginProviderAdapter = {
  id: 'agent-plugins',
  homes: () => [],
  enumerate: () => [],
  inspectSource: () => null,
  repositoryUrl: () => null,
  resolveUpdateSource: (source) => source,
  detectDir: (dir) => {
    if (!declaresAgentPluginsSchema(dir, 'plugin.json')) return null;
    const manifest = readManifestIdentity(dir, ['plugin.json']);
    return manifest ? { ...manifest, setupSupported: false } : null;
  },
};

export const codexPluginProvider = manifestDetectionProvider('codex', [
  '.codex-plugin/plugin.json',
]);

export const geminiPluginProvider = manifestDetectionProvider('gemini', ['gemini-extension.json']);

export const copilotPluginProvider: PluginProviderAdapter = {
  id: 'copilot',
  homes: () => [],
  enumerate: () => [],
  inspectSource: () => null,
  repositoryUrl: () => null,
  resolveUpdateSource: (source) => source,
  detectDir: (dir) => {
    const namespaced = readManifestIdentity(dir, [
      '.plugin/plugin.json',
      '.github/plugin/plugin.json',
    ]);
    if (namespaced) return { ...namespaced, setupSupported: false };
    if (!manifestDeclaresSkills(dir, 'plugin.json')) return null;
    const root = readManifestIdentity(dir, ['plugin.json']);
    return root ? { ...root, setupSupported: false } : null;
  },
};
