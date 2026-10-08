import {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  type ClientSurface,
  type ClientVersionTokenFields,
  clientVersionHeaders,
  clientVersionTokenFields,
  deriveClientSurface,
} from '@inkeep/open-knowledge-core/client-version';
import { detectEmbeddedHostFromBrowser } from '@inkeep/open-knowledge-core/constants/embedded-host';

const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

export const BROWSER_RUNTIME_VERSION: string =
  importMetaEnv?.VITE_APP_VERSION ?? CLIENT_RUNTIME_VERSION_FALLBACK;

export const CLIENT_SURFACE: ClientSurface = deriveClientSurface({
  hasDesktopBridge: typeof window !== 'undefined' && window.okDesktop !== undefined,
  embeddedHost: detectEmbeddedHostFromBrowser(),
});

export function browserClientVersionHeaders(): Record<string, string> {
  return clientVersionHeaders({ kind: CLIENT_SURFACE, runtimeVersion: BROWSER_RUNTIME_VERSION });
}

export function browserClientVersionTokenFields(): ClientVersionTokenFields {
  return clientVersionTokenFields({
    kind: CLIENT_SURFACE,
    runtimeVersion: BROWSER_RUNTIME_VERSION,
  });
}
