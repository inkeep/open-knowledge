import type { SkillBundle } from '../adapters/shared.ts';

/** Provider ids are persisted in lockfiles, so unknown future ids stay readable. */
export type PluginProviderId = string;

export interface PluginProviderHome {
  readonly harness: string;
  readonly dir: string;
}

/** Provider-neutral provenance extracted from an installed plugin source path. */
export interface PluginSourceInspection {
  readonly provider: PluginProviderId;
  readonly plugin: string;
  readonly version?: string;
  readonly marketplace?: string;
  readonly repositoryUrl?: string;
}

/** Capability presence-flags surfaced from a plugin bundle (never mapped/run). */
export interface PluginCapabilities {
  readonly commands: boolean;
  readonly hooks: boolean;
  readonly mcp: boolean;
  readonly agents: boolean;
}

/**
 * A plugin detected by inspecting a CLONED source repo (skills.sh import), not a
 * locally-installed plugin-manager path. `bundledSkills` are the skill-dir names
 * shipped alongside the manifest — the sibling set that powers dependent-ref
 * resolution and the "set up the whole plugin" disclosure. Empty when the
 * provider has no manifest convention that enumerates skills (e.g. OpenCode).
 */
export interface PluginBundleInspection {
  readonly provider: PluginProviderId;
  readonly plugin: string;
  readonly version?: string;
  readonly description?: string;
  readonly repositoryUrl?: string;
  readonly bundledSkills: readonly string[];
  readonly capabilities: PluginCapabilities;
  /** OK can drive setup only for providers it owns the lifecycle of (Claude);
   *  for the rest the "full plugin" action discloses + links, never executes. */
  readonly setupSupported: boolean;
}

/** One plugin manager's read-only discovery and source lifecycle contract. */
export interface PluginProviderAdapter {
  readonly id: PluginProviderId;
  /** Provider-owned user-global discovery roots. */
  homes(home: string): readonly PluginProviderHome[];
  enumerate(home: string, harness: string): SkillBundle[];
  inspectSource(source: string): Omit<PluginSourceInspection, 'provider' | 'repositoryUrl'> | null;
  repositoryUrl(source: string): string | null;
  resolveUpdateSource(source: string): string;
  /**
   * Recognize a CLONED repo dir as this provider's plugin by its manifest, and
   * return the plugin's identity — name/version/description read from the
   * manifest. Null when the dir carries no manifest of this provider's shape.
   * `bundledSkills`/capabilities are filled by the registry via the shared
   * `skills/`-dir convention, so an adapter only owns manifest recognition.
   * `setupSupported` marks whether OK can drive the provider's install.
   */
  detectDir(dir: string): {
    readonly plugin: string;
    readonly version?: string;
    readonly description?: string;
    readonly setupSupported: boolean;
  } | null;
}
