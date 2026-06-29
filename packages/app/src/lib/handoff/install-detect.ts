
import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { KNOWN_TARGETS } from './targets.ts';

export const UNIQUE_SCHEMES: ReadonlyArray<string> = [
  ...new Set(KNOWN_TARGETS.flatMap((t) => t.schemes)),
];

/** Per-scheme probe result. `lastChecked` is applied downstream on the target
 *  state, not stored per-scheme — the probe boundary is a pure snapshot. */
interface SchemeProbeResult {
  readonly installed: boolean;
  readonly displayName?: string;
}

export type SchemeStates = Readonly<Record<string, SchemeProbeResult>>;

export const DEFAULT_THROTTLE_MS = 10_000;

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

export function initialTargetStates(opts: {
  isElectronHost: boolean;
  now?: () => number;
}): Record<HandoffTarget, InstallState> {
  return schemeStatesToTargetStates({}, opts);
}

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

export interface ProbeDeps {
  /** One-shot probe — returns `SchemeStates` for every unique scheme.
   *  Strategies (`probeViaElectron`, `probeViaFetch`) satisfy this shape. */
  probe: () => Promise<SchemeStates>;
  isElectronHost: () => boolean;
  now: () => number;
  throttleMs?: number;
}

export interface ProbeHandle {
  /** Trigger a probe. Subject to throttle + inflight dedup. Resolves when the
   *  probe completes, or immediately if throttled / already inflight. */
  probe(): Promise<void>;
  getTargetStates(): Record<HandoffTarget, InstallState>;
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
