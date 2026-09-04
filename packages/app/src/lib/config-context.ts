import type { Config, ConfigBinding, OkignoreBinding } from '@inkeep/open-knowledge-core';
import { createContext, use } from 'react';

export interface ConfigContextValue {
  userBinding: ConfigBinding | null;
  userSynced: boolean;
  projectBinding: ConfigBinding | null;
  projectLocalBinding: ConfigBinding | null;
  okignoreBinding: OkignoreBinding | null;
  okignoreSynced: boolean;
  userConfig: Config | null;
  projectConfig: Config | null;
  projectSynced: boolean;
  projectLocalConfig: Config | null;
  projectLocalSynced: boolean;
  merged: Config | null;
}

export const ConfigContext = createContext<ConfigContextValue | null>(null);

export function useConfigContext(): ConfigContextValue {
  const ctx = use(ConfigContext);
  if (!ctx) {
    throw new Error('useConfigContext must be used within <ConfigProvider />');
  }
  return ctx;
}

export function useConfigContextOptional(): ConfigContextValue | null {
  return use(ConfigContext);
}
