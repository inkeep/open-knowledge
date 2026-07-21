import tls from 'node:tls';
import { getLogger } from './logger.ts';

let applied = false;

/**
 * Trust the OS certificate store (macOS Keychain, enterprise CA, …) for all TLS
 * in this process — the same store `git` already uses — so a GitHub Enterprise
 * Server on a self-signed or internal-CA certificate works for Node/undici API
 * calls instead of failing `DEPTH_ZERO_SELF_SIGNED_CERT` (which the auth path
 * otherwise mislabels "Token invalid", and which breaks the sync permission
 * probe).
 *
 * This is the in-process, runtime equivalent of `node --use-system-ca`. It runs
 * in every Node process that talks to the GitHub API — the CLI, the server
 * fork, and the desktop main process — because an Electron `use-system-ca`
 * command-line switch only reaches Chromium's network stack, not Node's
 * `fetch`/undici. Idempotent (safe to call from multiple entry points) and
 * feature-detected: `getCACertificates` / `setDefaultCACertificates` landed in
 * Node 22.15 / 23.8, so on older runtimes it no-ops and the bundled CA set
 * stays in place (today's behavior).
 */
export function trustSystemCertificates(): void {
  if (applied) return;
  const api = tls as unknown as {
    getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
    setDefaultCACertificates?: (certs: readonly string[]) => void;
  };
  if (
    typeof api.getCACertificates !== 'function' ||
    typeof api.setDefaultCACertificates !== 'function'
  ) {
    // Runtime lacks the API entirely — retrying can never succeed.
    applied = true;
    return;
  }
  try {
    // Union of Node's default bundle + the OS store, so public CAs keep working
    // while enterprise/self-signed roots also become trusted.
    api.setDefaultCACertificates([
      ...api.getCACertificates('default'),
      ...api.getCACertificates('system'),
    ]);
    // Only a successful apply latches the guard: a transient failure (e.g. a
    // locked Keychain at cold start) stays retryable on the next entry-point
    // call instead of being permanent for the process lifetime.
    applied = true;
  } catch (err) {
    // Never let CA setup block startup — fall back to the bundled bundle. But
    // leave a breadcrumb: the downstream symptom is a DEPTH_ZERO_SELF_SIGNED_CERT
    // auth/sync failure on GHES, which is hard to trace back here without it.
    getLogger('trust-system-ca').warn(
      { err },
      'system CA setup failed; falling back to the bundled CA set',
    );
  }
}

/** Test-only: reset the once-guard so a unit test can exercise the body. */
export function _resetTrustSystemCertificatesForTest(): void {
  applied = false;
}
