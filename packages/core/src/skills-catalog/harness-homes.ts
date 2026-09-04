import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_EDITOR_IDS,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
} from '../constants/editors.ts';
import { pluginProviderHomes } from './plugin-providers/registry.ts';
import type { PluginProviderId } from './plugin-providers/types.ts';

export type HarnessHome =
  | {
      readonly harness: string;
      readonly kind: 'plugin-provider';
      readonly provider: PluginProviderId;
      readonly dir: string;
    }
  | {
      readonly harness: string;
      readonly kind: 'skill-dir';
      readonly dir: string;
    };

export function harnessHomes(home: string = homedir()): HarnessHome[] {
  const editorHomes = ALL_EDITOR_IDS.flatMap<HarnessHome>((id) => {
    const root = EDITOR_USER_SKILL_ROOT[id];
    return root === null
      ? []
      : [{ harness: id, kind: 'skill-dir', dir: join(home, ...root.split('/')) }];
  });
  return [
    ...pluginProviderHomes(home).map<HarnessHome>((providerHome) => ({
      kind: 'plugin-provider',
      ...providerHome,
    })),
    ...editorHomes,
    { harness: 'agents', kind: 'skill-dir', dir: join(home, '.agents', 'skills') },
  ];
}

export function userGlobalSkillRoots(home: string = homedir()): string[] {
  return [...harnessHomes(home).map((h) => h.dir), join(home, '.ok', 'skills')];
}

export function projectHarnessHomes(projectDir: string): HarnessHome[] {
  return ALL_EDITOR_IDS.flatMap<HarnessHome>((id) => {
    const root = EDITOR_PROJECT_SKILL_ROOT[id];
    return root === null
      ? []
      : [{ harness: id, kind: 'skill-dir', dir: join(projectDir, ...root.split('/')) }];
  });
}
