/**
 * Build-time resolution of the web app's own version, for injection into the
 * browser bundle.
 *
 * The browser cannot read its own `package.json` at runtime, and it must NOT
 * fetch its version from the server — a stale tab that asks the *current*
 * server would always report itself compatible, defeating drift detection.
 * So the version is injected at build time and read from `import.meta.env`.
 *
 * Mechanism: every build path (the `packages/app` Vite config — which serves
 * both `bun run dev` and the bundle `ok ui` ships — and the `packages/desktop`
 * electron-vite renderer config) calls {@link injectAppVersionEnv} at config
 * module load. That sets `process.env.VITE_APP_VERSION`, which Vite then
 * surfaces on `import.meta.env.VITE_APP_VERSION` for both readers (the OTel
 * telemetry resource and the client-version wire builder). One build-time
 * source, two readers, divergent fallbacks (`'dev'` for telemetry, the
 * server-matching `'0.0.0-unknown'` for client-version).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The env var both browser readers consume via `import.meta.env`. */
export const APP_VERSION_ENV_VAR = 'VITE_APP_VERSION';

/**
 * Read the app's semver from `packages/app/package.json` (the install version
 * under the fixed-group lockstep). Returns the `'0.0.0-unknown'` sentinel —
 * matching the server's `readRuntimeVersion()` convention — if it can't be
 * resolved, so a build never injects a bogus value silently.
 */
export function resolveAppVersion(): string {
  try {
    // src/build/app-version.ts → ../../package.json (packages/app/package.json)
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to sentinel.
  }
  // Keep in sync with `CLIENT_RUNTIME_VERSION_FALLBACK` in
  // `@inkeep/open-knowledge-core` and the server's `readRuntimeVersion()`
  // sentinel. Not imported from core: this runs at Vite config-load time and
  // must not pull the core barrel (and its unrelated modules) into the build.
  return '0.0.0-unknown';
}

/**
 * Inject the resolved app version onto `process.env.VITE_APP_VERSION` so Vite
 * exposes it on `import.meta.env`. Call once at the top of each build's config
 * module. Returns the value it set (handy for logging / tests).
 */
export function injectAppVersionEnv(): string {
  const version = resolveAppVersion();
  process.env[APP_VERSION_ENV_VAR] = version;
  return version;
}
