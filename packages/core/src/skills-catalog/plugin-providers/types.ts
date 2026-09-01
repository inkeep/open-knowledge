import type { SkillBundle } from '../adapters/shared.ts';

export type PluginProviderId = string;

export interface PluginProviderHome {
  readonly harness: string;
  readonly dir: string;
}

export interface PluginSourceInspection {
  readonly provider: PluginProviderId;
  readonly plugin: string;
  readonly version?: string;
  readonly marketplace?: string;
  readonly repositoryUrl?: string;
}

export interface PluginCapabilities {
  readonly commands: boolean;
  readonly hooks: boolean;
  readonly mcp: boolean;
  readonly agents: boolean;
}

export interface PluginBundleInspection {
  readonly provider: PluginProviderId;
  readonly plugin: string;
  readonly version?: string;
  readonly description?: string;
  readonly repositoryUrl?: string;
  readonly bundledSkills: readonly string[];
  readonly capabilities: PluginCapabilities;
  readonly setupSupported: boolean;
}

export interface PluginProviderAdapter {
  readonly id: PluginProviderId;
  homes(home: string): readonly PluginProviderHome[];
  enumerate(home: string, harness: string): SkillBundle[];
  inspectSource(source: string): Omit<PluginSourceInspection, 'provider' | 'repositoryUrl'> | null;
  repositoryUrl(source: string): string | null;
  resolveUpdateSource(source: string): string;
  detectDir(dir: string): {
    readonly plugin: string;
    readonly version?: string;
    readonly description?: string;
    readonly setupSupported: boolean;
  } | null;
}
