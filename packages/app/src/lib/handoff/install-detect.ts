/**
 * Unified install-detection primitive for the Open-in-Agent dropdown. Two
 * probe strategies (one per host):
 *   - `probeViaElectron` — fans out `detectProtocol(scheme)` IPC calls.
 *   - `probeViaFetch`    — single `GET /api/installed-agents`; flat
 *     `{claude,codex,cursor}` response fanned out to scheme keys.
 *
 * `createProbeCoordinator` wraps either with throttle + inflight dedup so the
 * dropdown can `refresh()` liberally. Subscribers fire only on actual state
 * changes. Pure of React.
 *
 * Web-host Cursor used to be forced to `installed: false` because Cursor's
 * two-step dispatch needed Electron IPC for step 1 (spawn `cursor <path>`).
 * That override was removed once `cursor-two-step.ts` gained a fetch-based
 * fallback that posts to the loopback `POST /api/spawn-cursor` endpoint —
 * web hosts that talk to a local OK server now have feature parity with
 * Electron for Cursor handoff. Cloud-hosted OK (no loopback) gets a
 * `not-installed` outcome from the server probe and the row stays disabled.
 */

import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { KNOWN_TARGETS } from './targets.ts';

/** Unique URL schemes across all known targets. Computed once at module init. */
export const UNIQUE_SCHEMES: ReadonlyArray<string> = [
  ...new Set(KNOWN_TARGETS.flatMap((t) => t.schemes)),
];

/** Per-scheme probe result. `lastChecked` is applied downstream on the target
 *  state, not stored per-scheme — the probe boundary is a pure snapshot. */
interface SchemeProbeResult {
  readonly installed: boolean;
  readonly displayName?: string;
}

/** Scheme → probe-result map. Partial during boot; fully populated after a probe. */
export type SchemeStates = Readonly<Record<string, SchemeProbeResult>>;

export const DEFAULT_THROTTLE_MS = 10_000;

/**
 * Pure mapping: per-scheme probe results → per-target `InstallState`. Web-host
 * Cursor is forced to `installed: false` regardless of probed scheme state.
 */
export function schemeStatesToTargetStates(
  schemeStates: SchemeStates,
  opts: { isElectronHost: boolean; now?: () => number },
): Record<HandoffTarget, InstallState> {
  const now = opts.now?.() ?? Date.now();
  const out = {} as Record<HandoffTarget, InstallState>;
  for (const target of KNOWN_TARGETS) {
    const scheme = target.schemes[0];
    const probed = scheme !== undefined ? schemeStates[scheme] : undefined;
    if (!probed) {
      out[target.id] = { installed: null };
      continue;
    }
    out[target.id] = {
      installed: probed.installed,
      ...(probed.displayName !== undefined ? { displayName: probed.displayName } : {}),
      lastChecked: now,
    };
  }
  return out;
}

/** Initial `states` snapshot for a fresh hook mount (pre-probe). */
export function initialTargetStates(opts: {
  isElectronHost: boolean;
  now?: () => number;
}): Record<HandoffTarget, InstallState> {
  return schemeStatesToTargetStates({}, opts);
}

/**
 * Electron probe — one IPC call per unique scheme in parallel. Per-scheme
 * rejection collapses to `installed: false`.
 *
 * IPC contract: `detectProtocol` wants the scheme NAME without trailing colon
 * (`'claude'`, not `'claude:'`). The main-process sanitizer rejects colons
 * before `getApplicationInfoForProtocol` runs. `KNOWN_TARGETS.schemes`
 * carries the colonful form to match `URL.protocol`, so we strip here.
 */
export async function probeViaElectron(deps: {
  detectProtocol: (schemeName: string) => Promise<SchemeProbeResult>;
  schemes?: ReadonlyArray<string>;
}): Promise<SchemeStates> {
  const schemes = deps.schemes ?? UNIQUE_SCHEMES;
  const entries = await Promise.all(
    schemes.map(async (scheme) => {
      const schemeName = scheme.replace(/:$/, '');
      try {
        const result = await deps.detectProtocol(schemeName);
        return [scheme, result] as const;
      } catch {
        return [scheme, { installed: false } as SchemeProbeResult] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

const CONSERVATIVE_FALSE: SchemeStates = Object.fromEntries(
  UNIQUE_SCHEMES.map((s) => [s, { installed: false } as SchemeProbeResult]),
);

/**
 * Web probe — single `GET /api/installed-agents`. Server response is flat
 * `{claude: bool, codex: bool, cursor: bool}`; we add the colon back for
 * internal scheme keys. Any failure collapses to all-false conservative
 * default. AbortError propagates so callers can cancel in-flight fetches.
 */
export async function probeViaFetch(deps: {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<SchemeStates> {
  let res: Response;
  try {
    res = await deps.fetch('/api/installed-agents', {
      signal: deps.signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    return CONSERVATIVE_FALSE;
  }
  if (!res.ok) return CONSERVATIVE_FALSE;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return CONSERVATIVE_FALSE;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return CONSERVATIVE_FALSE;
  }
  const obj = body as Record<string, unknown>;
  const out: Record<string, SchemeProbeResult> = {};
  for (const scheme of UNIQUE_SCHEMES) {
    const key = scheme.replace(/:$/, '');
    out[scheme] = { installed: obj[key] === true };
  }
  return out;
}

/** Coordinator dependencies. Everything I/O-shaped is injected for testability. */
export interface ProbeDeps {
  /** One-shot probe — returns `SchemeStates` for every unique scheme.
   *  Strategies (`probeViaElectron`, `probeViaFetch`) satisfy this shape. */
  probe: () => Promise<SchemeStates>;
  /** Host classifier — true when Electron preload populated `window.okDesktop`. */
  isElectronHost: () => boolean;
  /** Clock reading. Production: `Date.now`. Tests: virtual. */
  now: () => number;
  /** Throttle window. Default `DEFAULT_THROTTLE_MS`. */
  throttleMs?: number;
}

export interface ProbeHandle {
  /** Trigger a probe. Subject to throttle + inflight dedup. Resolves when the
   *  probe completes, or immediately if throttled / already inflight. */
  probe(): Promise<void>;
  /** Read the current target-state snapshot (synchronous). */
  getTargetStates(): Record<HandoffTarget, InstallState>;
  /** Subscribe to state-change notifications. Returns an unsubscribe. */
  subscribe(cb: (states: Record<HandoffTarget, InstallState>) => void): () => void;
  /** Stop the coordinator — cancels subscriptions. A pending probe resolves
   *  without notifying. Idempotent. */
  cancel(): void;
}

/** Deep-equal check for the per-scheme probe map — avoids a re-render when the
 *  probe returns the same answer twice in a row (common case under throttle). */
function schemeStatesEqual(a: SchemeStates, b: SchemeStates): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const av = a[k];
    const bv = b[k];
    if (!av || !bv) return false;
    if (av.installed !== bv.installed) return false;
    if (av.displayName !== bv.displayName) return false;
  }
  return true;
}

export function createProbeCoordinator(deps: ProbeDeps): ProbeHandle {
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;
  let cancelled = false;
  let lastProbedAt: number | null = null;
  let inflight: Promise<void> | null = null;
  let schemeStates: SchemeStates = {};
  let cachedTargetStates: Record<HandoffTarget, InstallState> = initialTargetStates({
    isElectronHost: deps.isElectronHost(),
    now: deps.now,
  });
  const subscribers = new Set<(s: Record<HandoffTarget, InstallState>) => void>();

  const notifyAll = (): void => {
    if (cancelled) return;
    for (const cb of subscribers) cb(cachedTargetStates);
  };

  const refreshCachedSnapshot = (): void => {
    cachedTargetStates = schemeStatesToTargetStates(schemeStates, {
      isElectronHost: deps.isElectronHost(),
      now: deps.now,
    });
  };

  const probe = async (): Promise<void> => {
    if (cancelled) return;
    if (inflight) return inflight;
    if (lastProbedAt !== null && deps.now() - lastProbedAt < throttleMs) {
      return; // throttled — silent no-op
    }
    const run = (async () => {
      try {
        const next = await deps.probe();
        if (cancelled) return;
        const changed = !schemeStatesEqual(schemeStates, next);
        schemeStates = next;
        if (changed) {
          refreshCachedSnapshot();
          notifyAll();
        }
        lastProbedAt = deps.now();
      } catch {
        // Don't ratchet lastProbedAt on error — a transient flake can retry
        // immediately without waiting for the throttle window.
      } finally {
        inflight = null;
      }
    })();
    inflight = run;
    return run;
  };

  return {
    probe,
    getTargetStates: () => cachedTargetStates,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    cancel: () => {
      cancelled = true;
      subscribers.clear();
    },
  };
}
