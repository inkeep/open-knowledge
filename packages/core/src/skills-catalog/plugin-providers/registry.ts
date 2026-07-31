import type { SkillBundle } from '../adapters/shared.ts';
import { enumerateBundledSkills, inspectBundleCapabilities } from './bundle-inspect.ts';
import { claudePluginProvider } from './claude.ts';
import {
  codexPluginProvider,
  copilotPluginProvider,
  geminiPluginProvider,
} from './manifest-providers.ts';
import type {
  PluginBundleInspection,
  PluginProviderAdapter,
  PluginProviderHome,
  PluginProviderId,
  PluginSourceInspection,
} from './types.ts';

// Claude leads: OK owns the Claude plugin lifecycle, and a multi-harness repo
// (e.g. ponytail ships .claude-plugin/ AND .codex-plugin/ AND gemini-extension.json)
// should resolve to the provider OK can actually drive setup for.
const PROVIDERS = [
  claudePluginProvider,
  codexPluginProvider,
  geminiPluginProvider,
  copilotPluginProvider,
] as const satisfies readonly PluginProviderAdapter[];

function providerById(id: PluginProviderId): PluginProviderAdapter | undefined {
  return PROVIDERS.find((candidate) => candidate.id === id);
}

function providerCandidates(id?: PluginProviderId): readonly PluginProviderAdapter[] {
  if (id === undefined) return PROVIDERS;
  const provider = providerById(id);
  return provider ? [provider] : [];
}

export function pluginProviderHomes(
  home: string,
): Array<PluginProviderHome & { provider: PluginProviderId }> {
  return PROVIDERS.flatMap((provider) =>
    provider.homes(home).map((candidate) => ({ provider: provider.id, ...candidate })),
  );
}

export function enumeratePluginProvider(
  provider: PluginProviderId,
  home: string,
  harness: string = provider,
): SkillBundle[] {
  const adapter = providerById(provider);
  if (!adapter) throw new Error(`unknown plugin provider: ${provider}`);
  return adapter.enumerate(home, harness).map((bundle) => ({
    ...bundle,
    skills: bundle.skills.map((skill) => ({
      ...skill,
      provenance: { ...skill.provenance, pluginProvider: provider },
    })),
  }));
}

/** Inspect a source with the first provider that recognizes its on-disk format. */
export function inspectPluginSource(
  source: string,
  providerId?: PluginProviderId,
): PluginSourceInspection | null {
  for (const provider of providerCandidates(providerId)) {
    const inspection = provider.inspectSource(source);
    if (!inspection) continue;
    const repositoryUrl = provider.repositoryUrl(source);
    return {
      provider: provider.id,
      ...inspection,
      ...(repositoryUrl ? { repositoryUrl } : {}),
    };
  }
  return null;
}

/**
 * Recognize a CLONED source repo (a skills.sh import) as a plugin — skills.sh
 * surfaces one skill and never flags the plugin relationship, but the source
 * repo carries the manifest, and the preview/discover path already clones it.
 * The first provider whose manifest the dir matches wins; the shared
 * `skills/`-dir convention then enumerates the bundled siblings + capability
 * flags. Returns null for a bare skill repo (no plugin manifest) or a plugin
 * that ships no `skills/` dir (nothing to bundle-offer). Read-only — inspects
 * manifests, executes nothing.
 */
export function inspectPluginBundleDir(dir: string): PluginBundleInspection | null {
  for (const provider of PROVIDERS) {
    const detected = provider.detectDir(dir);
    if (!detected) continue;
    const bundledSkills = enumerateBundledSkills(dir);
    if (bundledSkills.length === 0) return null;
    return {
      provider: provider.id,
      plugin: detected.plugin,
      ...(detected.version ? { version: detected.version } : {}),
      ...(detected.description ? { description: detected.description } : {}),
      bundledSkills,
      capabilities: inspectBundleCapabilities(dir),
      setupSupported: detected.setupSupported,
    };
  }
  return null;
}

/** Resolve repository metadata without requiring a complete plugin inspection. */
export function pluginRepositoryUrl(source: string, providerId?: PluginProviderId): string | null {
  for (const provider of providerCandidates(providerId)) {
    if (!provider.inspectSource(source)) continue;
    const repositoryUrl = provider.repositoryUrl(source);
    if (repositoryUrl) return repositoryUrl;
  }
  return null;
}

/** Follow a provider-managed source to its current update candidate. */
export function resolvePluginUpdateSource(source: string, providerId?: PluginProviderId): string {
  for (const provider of providerCandidates(providerId)) {
    if (!provider.inspectSource(source)) continue;
    return provider.resolveUpdateSource(source);
  }
  return source;
}
