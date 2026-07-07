/**
 * Browser-side resolver for this client's own version metadata.
 *
 * The runtime semver is build-time-injected onto `import.meta.env.VITE_APP_VERSION`
 * (see `src/build/app-version.ts`) — the browser cannot read its own
 * `package.json`, and must not fetch its version from the server (a stale tab
 * would read the *current* server's value and always look compatible). The
 * protocol version is the pure constant baked into the shared builder.
 *
 * The client kind is always `web`: this same bundle runs as the web app and as
 * the desktop renderer, both on the browser HTTP + Hocuspocus transports. Only
 * the desktop *main* (Node) process identifies as `desktop-main`.
 */
import {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  type ClientVersionTokenFields,
  clientVersionHeaders,
  clientVersionTokenFields,
} from '@inkeep/open-knowledge-core';

const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

/**
 * This browser bundle's own semver, build-time-injected. Falls back to the
 * server-matching sentinel if the Vite `define`/env wiring is missing from a
 * build path — a value that reads as "unknown" rather than masquerading as a
 * real version.
 */
export const BROWSER_RUNTIME_VERSION: string =
  importMetaEnv?.VITE_APP_VERSION ?? CLIENT_RUNTIME_VERSION_FALLBACK;

/** The three `x-ok-client-*` headers for browser HTTP requests (kind `web`). */
export function browserClientVersionHeaders(): Record<string, string> {
  return clientVersionHeaders({ kind: 'web', runtimeVersion: BROWSER_RUNTIME_VERSION });
}

/** The Hocuspocus auth-token version fields for browser WS connects (kind `web`). */
export function browserClientVersionTokenFields(): ClientVersionTokenFields {
  return clientVersionTokenFields({ kind: 'web', runtimeVersion: BROWSER_RUNTIME_VERSION });
}
