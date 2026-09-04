import {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  type ClientVersionTokenFields,
  clientVersionHeaders,
  clientVersionTokenFields,
} from '@inkeep/open-knowledge-core';

const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

export const BROWSER_RUNTIME_VERSION: string =
  importMetaEnv?.VITE_APP_VERSION ?? CLIENT_RUNTIME_VERSION_FALLBACK;

export function browserClientVersionHeaders(): Record<string, string> {
  return clientVersionHeaders({ kind: 'web', runtimeVersion: BROWSER_RUNTIME_VERSION });
}

export function browserClientVersionTokenFields(): ClientVersionTokenFields {
  return clientVersionTokenFields({ kind: 'web', runtimeVersion: BROWSER_RUNTIME_VERSION });
}
