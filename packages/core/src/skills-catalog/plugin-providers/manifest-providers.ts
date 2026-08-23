/**
 * Detection-only plugin providers for the non-Claude harnesses. skills.sh never
 * flags the plugin relationship, but a source repo's manifest does — and Codex,
 * Gemini, and Copilot all ship a top-level `{name, version, description}`
 * manifest, differing only in WHERE it lives. So they collapse to one factory
 * over `readManifestIdentity`; the shared `skills/`-dir convention (registry)
 * enumerates the bundled siblings + capability flags.
 *
 * These providers own MANIFEST RECOGNITION only. OK does not enumerate their
 * locally-installed plugins or drive their install lifecycle, so `enumerate` /
 * `inspectSource` / `homes` are inert and `setupSupported` is false — the "full
 * plugin" action discloses + links for these, never executes.
 *
 * OpenCode is intentionally absent: it has NO plugin manifest (plugins are JS
 * modules referenced from `opencode.json`'s `plugin` array), so there is no
 * name/version to read and no manifest-declared skill set to bundle. Detecting
 * it would surface a nameless, skill-less "plugin" — worse than not detecting.
 */

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

/** Does the JSON manifest at `dir/rel` declare a `skills` field? The Copilot
 *  discriminator for a bare-root `plugin.json` — a real skill-bundling plugin
 *  points `skills` at its dir(s); an unrelated root `plugin.json` (a common
 *  filename) does not, so this keeps detection from mislabeling it. */
function manifestDeclaresSkills(dir: string, rel: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, rel), 'utf-8')) as { skills?: unknown };
    return parsed.skills !== undefined;
  } catch {
    return false;
  }
}

/**
 * The vendor-neutral Agent Plugins standard (agent-plugins.org): `plugin.json`
 * at the plugin ROOT, with `skills/` and `mcp.json` discovered by convention.
 *
 * Detected on `$schema`, not on a component field, because the spec forbids the
 * field: "plugin.json cannot override these locations or contain inline
 * component configuration." That makes the Copilot discriminator below —
 * a declared `skills` field — exactly wrong here: a CONFORMANT plugin has no
 * such field and was invisible, while one carrying it (a spec violation) was
 * detected and mislabeled Copilot. `$schema` is the stronger signal anyway; it
 * names the standard outright rather than inferring it.
 *
 * Ordered ahead of Copilot in the registry so the namespaced Copilot paths still
 * win for their own shape while a standard root manifest is claimed here.
 */
const AGENT_PLUGINS_SCHEMA_HOST = 'agent-plugins.org';
function declaresAgentPluginsSchema(dir: string, rel: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, rel), 'utf-8')) as { $schema?: unknown };
    return typeof parsed.$schema === 'string' && parsed.$schema.includes(AGENT_PLUGINS_SCHEMA_HOST);
  } catch {
    return false;
  }
}
/** The spec's plugin-name grammar: 1-64 chars, lowercase alphanumeric with
 *  single hyphens/periods inside, alphanumeric at both ends. */
const AGENT_PLUGIN_NAME_RE = /^(?!.*[-.]{2})[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

/**
 * Enumerate an Agent Plugins ROOT — a directory whose children are conformant
 * plugin dirs (`<root>/<plugin>/plugin.json` + `skills/`). This is the LOCAL
 * half of the standard's support: `detectDir` below recognizes a cloned repo on
 * the import path; this reads plugins already sitting on disk (an in-project
 * `plugins/` tree, a configured root, a client's install store) so their skills
 * surface as detected rows with plugin provenance.
 *
 * Spec semantics observed: detection is by `$schema` (the spec forbids
 * component fields in the manifest); a name failing the constraint grammar
 * disqualifies the plugin; skills are the immediate children of `skills/`
 * holding a `SKILL.md`, no recursion, invalid ones skipped; a missing `skills/`
 * is non-fatal (the plugin just contributes nothing here). Read-only — this is
 * vendor state exactly like the Claude cache.
 */
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

/** The manifest's optional `repository` URL, or null. */
function manifestRepositoryUrl(dir: string, rel: string): string | null {
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

/** OpenAI Codex CLI: `.codex-plugin/plugin.json` (manifest inside `.codex-plugin/`,
 *  `skills/` at repo root). Source: developers.openai.com/codex/plugins/build. */
export const codexPluginProvider = manifestDetectionProvider('codex', [
  '.codex-plugin/plugin.json',
]);

/** Google Gemini CLI: `gemini-extension.json` at the extension root.
 *  Source: github.com/google-gemini/gemini-cli docs/extensions/reference.md. */
export const geminiPluginProvider = manifestDetectionProvider('gemini', ['gemini-extension.json']);

/**
 * GitHub Copilot CLI: `plugin.json` in a Copilot-namespaced dir (`.plugin/` or
 * `.github/plugin/`) — unambiguous — OR a bare-root `plugin.json` that declares
 * a `skills` field. The bare-root file is a common filename, so requiring the
 * Copilot `skills` discriminator keeps an unrelated root `plugin.json` from
 * being mislabeled a Copilot plugin. `.claude-plugin/` is omitted (Claude
 * claims that shape first). Source: docs.github.com Copilot CLI plugins.
 */
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
