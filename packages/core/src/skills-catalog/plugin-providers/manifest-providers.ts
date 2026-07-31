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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
