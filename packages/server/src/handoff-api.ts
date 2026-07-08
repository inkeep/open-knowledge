/**
 * GET /api/installed-agents — server-side install-detection for the web host.
 *
 * The browser can't enumerate the OS's scheme handlers directly, so the server
 * probes on its behalf. Web-host parity for the Electron
 * `ok:shell:detect-protocol` IPC in `packages/desktop/src/main/ipc-handlers.ts`.
 *
 * Per-OS probe:
 *   - macOS:   `osascript -e 'id of app "<AppName>"'` — non-empty stdout means
 *              installed. Multiple candidate display names per scheme because
 *              vendors rename between versions.
 *   - Windows: `reg query "HKCR\<scheme>" /ve` — HKCR is the merged view of
 *              HKCU\Software\Classes + HKLM\Software\Classes, so this catches
 *              both user-scope and machine-scope (MSI / enterprise) installs.
 *              Querying HKCU alone would miss machine-scope registrations.
 *   - Linux:   `xdg-mime query default x-scheme-handler/<scheme>`.
 *
 * Cache policy: per-scheme 60 s TTL with in-flight dedup so a burst of
 * requests triggers exactly one OS probe per scheme. Probe timeout / error →
 * `installed: false`.
 */

import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InstalledAgentsSuccessSchema } from '@inkeep/open-knowledge-core';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { errorResponse } from './http/error-response.ts';
import { successResponse } from './http/success-response.ts';

export const INSTALLED_AGENTS_SCHEMES = ['claude', 'codex', 'cursor'] as const;
export type InstalledAgentScheme = (typeof INSTALLED_AGENTS_SCHEMES)[number];

export const INSTALLED_AGENTS_CACHE_TTL_MS = 60_000;
const INSTALLED_AGENTS_PROBE_TIMEOUT_MS = 2000;

/**
 * macOS app-name candidates per scheme. `osascript` asks for an app by its
 * Launch Services display name and rejects hard on an exact-name mismatch —
 * so a vendor rename masquerades as "not installed." Try every candidate in
 * order; first non-empty `id of app` result wins. Keep the vendor's current
 * marketing name first; add aliases only after an observed install-detection
 * miss in the wild.
 */
const MACOS_APP_NAMES: Record<InstalledAgentScheme, ReadonlyArray<string>> = {
  claude: ['Claude'],
  codex: ['Codex', 'OpenAI Codex'],
  cursor: ['Cursor'],
};

/**
 * Minimal signature of `node:child_process`'s `execFile` — the subset this
 * module actually calls. Injectable so unit tests can replace with a
 * deterministic fake.
 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  opts: { timeout?: number; encoding?: BufferEncoding; windowsHide?: boolean },
  cb: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
) => void;

interface InstalledAgentsProbeDeps {
  /** Probe one scheme against the OS; returns true iff install-registered. */
  probe: (scheme: InstalledAgentScheme) => Promise<boolean>;
  /** Clock override — defaults to `Date.now`. Tests inject a fake clock. */
  now?: () => number;
  /** TTL override — defaults to `INSTALLED_AGENTS_CACHE_TTL_MS`. */
  ttlMs?: number;
}

type CacheEntry =
  | { status: 'resolved'; installed: boolean; expiresAt: number }
  | { status: 'inflight'; promise: Promise<boolean> };

/**
 * Factory for a per-scheme cached probe. Returns `probeAll` (fetches every
 * scheme) and `probeWithCache` (single scheme; exposed for targeted tests).
 *
 * Cache invariants:
 *   - Fresh resolved entry (expiresAt > now()) → return cached value; no probe.
 *   - In-flight promise → return the same promise; coalesces concurrent calls.
 *   - Stale or absent → launch a new probe; stash the in-flight promise so a
 *     second caller before resolution still joins the same probe.
 *   - Probe rejection is swallowed: cache `{installed:false}` for the full TTL
 *     so a flaky probe doesn't re-fire on every request.
 */
export function createInstalledAgentsProbe(deps: InstalledAgentsProbeDeps): {
  probeAll: () => Promise<Record<InstalledAgentScheme, boolean>>;
  probeWithCache: (scheme: InstalledAgentScheme) => Promise<boolean>;
} {
  const cache = new Map<InstalledAgentScheme, CacheEntry>();
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? INSTALLED_AGENTS_CACHE_TTL_MS;

  async function probeWithCache(scheme: InstalledAgentScheme): Promise<boolean> {
    const cached = cache.get(scheme);
    if (cached?.status === 'resolved' && cached.expiresAt > now()) {
      return cached.installed;
    }
    if (cached?.status === 'inflight') {
      return cached.promise;
    }
    const promise = (async () => {
      try {
        const installed = await deps.probe(scheme);
        cache.set(scheme, { status: 'resolved', installed, expiresAt: now() + ttl });
        return installed;
      } catch {
        cache.set(scheme, { status: 'resolved', installed: false, expiresAt: now() + ttl });
        return false;
      }
    })();
    cache.set(scheme, { status: 'inflight', promise });
    return promise;
  }

  async function probeAll(): Promise<Record<InstalledAgentScheme, boolean>> {
    const entries = await Promise.all(
      INSTALLED_AGENTS_SCHEMES.map(
        async (s): Promise<readonly [InstalledAgentScheme, boolean]> => [
          s,
          await probeWithCache(s),
        ],
      ),
    );
    return Object.fromEntries(entries) as Record<InstalledAgentScheme, boolean>;
  }

  return { probeAll, probeWithCache };
}

/**
 * Capability-tier host detector. When the browser's `Host` header names a
 * loopback hostname (the user typed `http://localhost:port` / `127.0.0.1`),
 * the server and the browser are co-located — the per-scheme OS probe
 * accurately reflects what the user has installed.
 *
 * When the Host header is a non-loopback hostname (the server is hosted for
 * a browser on a different machine, common in reverse-proxy / SSH-forward /
 * remote-dev setups), probing the server's filesystem would describe a
 * different machine. Callers return all-installed in that case and let the
 * browser's own OS protocol-dispatch dialog ("Open Cursor?") be the truth
 * signal. This is the legitimate channel — the ban on browser-side
 * fingerprinting / scheme-flood probing is upheld.
 *
 * The route gate (`checkLocalOpSecurity`) still rejects non-loopback sockets;
 * this helper is the second tier that distinguishes "loopback connection,
 * browser thinks it's local" (e.g., same machine) from "loopback connection,
 * browser thinks it's remote" (e.g., SSH tunnel terminating on the server).
 *
 * Absent or malformed `Host` falls back to the Origin header (browsers send
 * Origin on cross-origin and same-origin fetches alike to `/api/*` because
 * `Access-Control-Allow-Origin: *` is in effect). If neither resolves, the
 * conservative default is local-web: the loopback gate has already filtered
 * out everything not on the same machine.
 */
export function isLocalWebHost(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader === 'string' && hostHeader.length > 0) {
    try {
      const { hostname } = new URL(`http://${hostHeader}/`);
      return isLoopbackHostname(hostname);
    } catch {
      // Fall through to Origin — malformed Host shouldn't itself flip the
      // capability tier when Origin would have answered cleanly.
    }
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      return isLoopbackHostname(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  return true;
}

function isLoopbackHostname(hostname: string): boolean {
  // WHATWG URL preserves IPv6 brackets in `hostname` (e.g. `[::1]`); include
  // the bracketed form alongside the bare literal so either parse path matches.
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * 405 on non-GET → RFC 9457 `application/problem+json`. 200 + flat
 * `{claude, codex, cursor}` body on success (no `{ok:true,...}` wrapper) —
 * the consumer `probeViaFetch` in
 * `packages/app/src/lib/handoff/install-detect.ts` keys off the three literal
 * scheme names directly.
 *
 * Caller (`handleInstalledAgentsRoute` in `api-extension.ts`) gates with
 * `checkLocalOpSecurity` first; this function trusts that the request has
 * passed the loopback + DNS-rebinding guard. After the gate, the response
 * tier is chosen by `isLocalWebHost`: local-web returns the real per-scheme
 * probe; remote-web returns `Record<scheme, true>` so every agent renders
 * and the browser's OS protocol-dispatch dialog becomes the truth signal.
 * That keeps the ban intact (no browser-side fingerprinting) without the
 * silent-failure UX of probing the wrong machine.
 */
export async function handleInstalledAgents(
  req: IncomingMessage,
  res: ServerResponse,
  probeAll: () => Promise<Record<InstalledAgentScheme, boolean>>,
): Promise<void> {
  if (req.method !== 'GET') {
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'installed-agents',
      extraHeaders: { Allow: 'GET' },
    });
    return;
  }
  try {
    const result = isLocalWebHost(req)
      ? await probeAll()
      : (Object.fromEntries(INSTALLED_AGENTS_SCHEMES.map((s) => [s, true] as const)) as Record<
          InstalledAgentScheme,
          boolean
        >);
    successResponse(res, 200, InstalledAgentsSuccessSchema, result, {
      handler: 'installed-agents',
    });
  } catch (e) {
    console.error('[installed-agents]', e);
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
      handler: 'installed-agents',
      cause: e,
    });
  }
}

/**
 * Build the default OS probe for the current platform. Tests inject a fake
 * `exec` to avoid actually calling `osascript` / `reg` / `xdg-mime`.
 *
 * Unknown platforms fall through to the Linux branch — the `xdg-mime` probe
 * simply returns false on systems where the tool isn't installed, matching
 * the conservative-default invariant.
 */
export function createOsProbe(
  platform: NodeJS.Platform,
  exec: ExecFileLike = execFile as ExecFileLike,
): (scheme: InstalledAgentScheme) => Promise<boolean> {
  return (scheme) => {
    if (platform === 'darwin') return probeMacOs(scheme, exec);
    if (platform === 'win32') return probeWindows(scheme, exec);
    return probeLinux(scheme, exec);
  };
}

function probeMacOs(scheme: InstalledAgentScheme, exec: ExecFileLike): Promise<boolean> {
  const candidates = MACOS_APP_NAMES[scheme];
  function tryCandidate(appName: string): Promise<boolean> {
    return new Promise((resolve) => {
      exec(
        'osascript',
        ['-e', `id of app "${appName}"`],
        withHiddenWindowsConsole({
          timeout: INSTALLED_AGENTS_PROBE_TIMEOUT_MS,
          encoding: 'utf-8',
        }),
        (err, stdout) => {
          if (err) {
            resolve(false);
            return;
          }
          resolve(stdout.trim().length > 0);
        },
      );
    });
  }
  return (async () => {
    for (const candidate of candidates) {
      if (await tryCandidate(candidate)) return true;
    }
    return false;
  })();
}

function probeWindows(scheme: InstalledAgentScheme, exec: ExecFileLike): Promise<boolean> {
  return new Promise((resolve) => {
    // HKCR is the merged view of HKCU\Software\Classes + HKLM\Software\Classes;
    // querying HKCU alone misses MSI / system-wide installs.
    exec(
      'reg',
      ['query', `HKCR\\${scheme}`, '/ve'],
      withHiddenWindowsConsole({
        timeout: INSTALLED_AGENTS_PROBE_TIMEOUT_MS,
        encoding: 'utf-8',
      }),
      (err) => {
        resolve(!err);
      },
    );
  });
}

function probeLinux(scheme: InstalledAgentScheme, exec: ExecFileLike): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      'xdg-mime',
      ['query', 'default', `x-scheme-handler/${scheme}`],
      withHiddenWindowsConsole({
        timeout: INSTALLED_AGENTS_PROBE_TIMEOUT_MS,
        encoding: 'utf-8',
      }),
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.trim().length > 0);
      },
    );
  });
}
