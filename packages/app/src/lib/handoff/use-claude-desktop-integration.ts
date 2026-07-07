/**
 * Reactive hook that consolidates the three Claude-Desktop integration signals
 * — app presence (config-dir / IPC), URL-scheme registration (handled by
 * `useInstalledAgents` per scheme — NOT consolidated here), and OK skill
 * install state (`~/.ok/skill-state.yml` via `/api/skill/install-state`, with a
 * localStorage fast-path mirror) — into one source of truth.
 *
 * Three callers branch on this state: `OpenInAgentMenu` and
 * `OpenInAgentContextSubmenu` (to render the INSTALL badge on the Claude
 * Cowork row when desktop is present but skill is not), and `SettingsDialog`
 * (to hide the row entirely when desktop is absent and to relabel
 * Install → Reinstall when the skill is installed).
 *
 * Module-level cache + subscriber pattern: every consumer mount shares a
 * single in-flight probe per refresh cycle. Without this each menu open and
 * each Settings tab switch would trigger an independent `/api/skill/install-state`
 * fetch.
 */

import { useEffect, useSyncExternalStore } from 'react';
// Loads the `Window.okDesktop?` global augmentation.
import '@/lib/desktop-bridge-types';

interface ClaudeDesktopIntegrationState {
  readonly desktopPresent: boolean;
  readonly skillInstalled: boolean;
  readonly skillVersion: string | null;
}

interface SkillInstallStateSnapshot {
  currentVersion: string;
  targets?: Partial<Record<string, { version: string; recordedAt?: string } | null>>;
}

interface LocalStorageGuardResult {
  readonly skillInstalled: boolean;
  readonly skillVersion: string | null;
}

export interface ProbeDeps {
  /** Resolves to true when Claude Desktop's config dir exists. Absent → web host (default `true`). */
  readonly detectClaudeDesktop?: (() => Promise<boolean>) | undefined;
  /** Server probe. Implementations should swallow network/abort errors and resolve `null`. */
  readonly fetchSnapshot: () => Promise<SkillInstallStateSnapshot | null>;
  /** localStorage scan for any `ok:skill:cowork:installed:v<version>` key. */
  readonly readLocalStorageGuard: () => LocalStorageGuardResult;
}

const COWORK_TARGET = 'claude-cowork';
const GUARD_KEY_PREFIX = 'ok:skill:cowork:installed:v';
const SKILL_STATE_FETCH_TIMEOUT_MS = 250;
const INSTALL_STATE_PATH = '/api/skill/install-state';

let cache: ClaudeDesktopIntegrationState | null = null;
const subscribers = new Set<() => void>();
let inflight: Promise<void> | null = null;

// Module-level window event handlers — refcounted via `subscribers.size` so a
// single pair of listeners serves every concurrent hook instance. Previously
// each `useClaudeDesktopIntegration()` mount registered its own focus +
// storage pair; with N consumer surfaces (Settings dialog, Integrations row,
// Open-in header dropdown, FileTree context submenu) that grew O(N). The
// `inflight` coalescer made the real cost negligible, but registering one
// pair instead of N is the same shape as the existing `subscribers` Set + the
// module-level `cache` — extending refcount semantics to listeners closes the
// last bit of per-instance state.
let listenersAttached = false;
const onWindowFocus = (): void => {
  void runIntegrationProbe(defaultDeps());
};
const onWindowStorage = (e: StorageEvent): void => {
  if (e.key?.startsWith(GUARD_KEY_PREFIX)) {
    void runIntegrationProbe(defaultDeps());
  }
};
function attachWindowListeners(): void {
  if (listenersAttached) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('storage', onWindowStorage);
  listenersAttached = true;
}
function detachWindowListeners(): void {
  if (!listenersAttached) return;
  if (typeof window === 'undefined') return;
  window.removeEventListener('focus', onWindowFocus);
  window.removeEventListener('storage', onWindowStorage);
  listenersAttached = false;
}

// Module-level one-shot warn gates. Silent fallbacks for every failure mode
// preserve UX (safe defaults) but invisible failures hide bugs — a broken IPC
// bridge or 500'ing /api/skill/install-state looks identical to "genuinely no
// install" in production. One log per process per failure mode is the floor:
// enough signal to triage, no log-spam if the failure is sustained.
let warnedDesktopDetectThrew = false;
let warnedFetchThrew = false;
let warnedFetchTimeout = false;
let warnedFetchNonOk = false;
let warnedJsonParseThrew = false;
let warnedFetchShapeDrift = false;
let warnedLocalStorageThrew = false;

/**
 * Pure probe — runs all three checks and resolves the merged state. Errors in
 * any branch fall back to safe defaults (`desktopPresent=true`, fetch
 * unreachable → localStorage scan → no guard → `skillInstalled=false`). The
 * safe default for `skillInstalled` is `false` because surfacing the install
 * affordance on a machine that already has the skill is cheaper UX than
 * hiding it on a machine that doesn't.
 */
export async function probeClaudeDesktopIntegration(
  deps: ProbeDeps,
): Promise<ClaudeDesktopIntegrationState> {
  let desktopPresent = true;
  if (deps.detectClaudeDesktop) {
    try {
      desktopPresent = await deps.detectClaudeDesktop();
    } catch (err) {
      desktopPresent = true;
      if (!warnedDesktopDetectThrew) {
        warnedDesktopDetectThrew = true;
        console.warn(
          '[claude-desktop-integration] detectClaudeDesktop IPC rejected — falling back to desktopPresent=true',
          err,
        );
      }
    }
  }

  // ProbeDeps contract (see JSDoc): `fetchSnapshot` and `readLocalStorageGuard`
  // implementations swallow their own errors and return safe defaults
  // (`null` and `{ skillInstalled: false, skillVersion: null }` respectively).
  // The production defaults honor this; tests injecting throwing deps would
  // be exercising a contract the production layer doesn't ship.
  const snapshot = await deps.fetchSnapshot();

  if (snapshot) {
    const target = snapshot.targets?.[COWORK_TARGET] ?? null;
    if (target?.version) {
      return { desktopPresent, skillInstalled: true, skillVersion: target.version };
    }
    return { desktopPresent, skillInstalled: false, skillVersion: null };
  }

  const guard = deps.readLocalStorageGuard();
  return { desktopPresent, skillInstalled: guard.skillInstalled, skillVersion: guard.skillVersion };
}

/**
 * Coalesces concurrent probe requests into one in-flight Promise. Emits the
 * result to every subscriber. Tests inject deps; the React hook uses
 * `defaultDeps()`.
 */
export async function runIntegrationProbe(deps: ProbeDeps): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = await probeClaudeDesktopIntegration(deps);
      cache = next;
      // Wrap each subscriber so a throwing callback can't starve siblings.
      // `useSyncExternalStore` subscribers don't throw in practice, but
      // exported `subscribeClaudeDesktopIntegration` is part of the public
      // surface — a future third-party subscriber could.
      for (const cb of subscribers) {
        try {
          cb();
        } catch (err) {
          console.error('[claude-desktop-integration] subscriber threw', err);
        }
      }
    } catch (err) {
      // probeClaudeDesktopIntegration is designed to never reject (all branches
      // catch their own errors with documented fallbacks), but every caller
      // discards this Promise with `void`. An unexpected throw would surface
      // as an unhandled promise rejection — log it instead so it's debuggable.
      console.error('[claude-desktop-integration] probe rejected unexpectedly', err);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test seam. Clears module-level state so each test starts deterministic. */
export function resetClaudeDesktopIntegrationForTest(): void {
  cache = null;
  subscribers.clear();
  inflight = null;
  // Drop the refcounted window listeners explicitly — `subscribers.clear()`
  // bypasses the unsubscribe path, so the attached flag would otherwise
  // survive the reset and leak state across tests.
  detachWindowListeners();
  warnedDesktopDetectThrew = false;
  warnedFetchThrew = false;
  warnedFetchTimeout = false;
  warnedFetchNonOk = false;
  warnedJsonParseThrew = false;
  warnedFetchShapeDrift = false;
  warnedLocalStorageThrew = false;
}

/** Test seam. Lets tests assert the current cache without spinning up a hook. */
export function peekClaudeDesktopIntegrationCache(): ClaudeDesktopIntegrationState | null {
  return cache;
}

/** Register a `useSyncExternalStore`-compatible subscriber. The handler is
 *  invoked with no arguments whenever a probe completes; the consumer calls
 *  `getClaudeDesktopIntegrationSnapshot()` (or the hook resolves via the
 *  store contract) to read the new value. Returns an unsubscribe function. */
export function subscribeClaudeDesktopIntegration(handler: () => void): () => void {
  // First subscriber attaches the shared window listeners; last unsubscribe
  // detaches them. The size check runs before the add/delete so we observe
  // the "0 → 1" and "1 → 0" transitions; the attach/detach helpers are
  // idempotent so spurious calls are safe (e.g. handlers in a server-render
  // pass where `typeof window === 'undefined'`).
  if (subscribers.size === 0) attachWindowListeners();
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
    if (subscribers.size === 0) detachWindowListeners();
  };
}

/** `useSyncExternalStore` snapshot — returns the current module-level cache
 *  by reference. Stable across calls until a probe replaces `cache`. */
export function getClaudeDesktopIntegrationSnapshot(): ClaudeDesktopIntegrationState | null {
  return cache;
}

function defaultDetectClaudeDesktop(): (() => Promise<boolean>) | undefined {
  if (typeof window === 'undefined') return undefined;
  const skill = window.okDesktop?.skill;
  const detect = skill?.detectClaudeDesktop;
  if (!detect) return undefined;
  return () => detect.call(skill);
}

/**
 * Default fetcher — same-origin GET against `/api/skill/install-state` with a
 * 250ms `AbortController` timeout. Matches the budget used by
 * `cowork-skill-install.ts` so a slow server can't stall any consumer.
 */
export function createDefaultFetchSnapshot(opts?: {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): () => Promise<SkillInstallStateSnapshot | null> {
  const timeoutMs = opts?.timeoutMs ?? SKILL_STATE_FETCH_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  return async () => {
    if (!fetchImpl) return null;
    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetchImpl(INSTALL_STATE_PATH, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // AbortError fires when the 250ms timer pops; everything else (network
      // down, CORS, DNS) trips the same catch. Distinguish in the log so
      // ops triage knows whether to look at server latency or connectivity.
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      if (isTimeout && !warnedFetchTimeout) {
        warnedFetchTimeout = true;
        console.warn(
          `[claude-desktop-integration] fetch ${INSTALL_STATE_PATH} timed out (>${timeoutMs}ms) — falling back to localStorage guard`,
        );
      } else if (!isTimeout && !warnedFetchThrew) {
        warnedFetchThrew = true;
        console.warn(
          `[claude-desktop-integration] fetch ${INSTALL_STATE_PATH} failed — falling back to localStorage guard`,
          err,
        );
      }
      return null;
    }
    if (!response.ok) {
      if (!warnedFetchNonOk) {
        warnedFetchNonOk = true;
        console.warn(
          `[claude-desktop-integration] ${INSTALL_STATE_PATH} returned ${response.status} ${response.statusText} — falling back to localStorage guard`,
        );
      }
      return null;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (!warnedJsonParseThrew) {
        warnedJsonParseThrew = true;
        console.warn(
          `[claude-desktop-integration] ${INSTALL_STATE_PATH} returned unparseable JSON — falling back to localStorage guard`,
          err,
        );
      }
      return null;
    }
    return validateSkillInstallStateSnapshot(body);
  };
}

// Boundary validator — the server type contract for `/api/skill/install-state`
// is declared in TS but not enforced at runtime. A drifted server (or buggy
// fixture) could ship `{ targets: { 'claude-cowork': { version: 42 } } }`
// and the unchecked cast would poison the cache with non-string values that
// the type system guarantees are strings everywhere downstream. Exported so
// each shape-drift branch gets a direct test target.
export function validateSkillInstallStateSnapshot(body: unknown): SkillInstallStateSnapshot | null {
  if (body === null || typeof body !== 'object') return reportShapeDrift('not an object');
  const obj = body as Record<string, unknown>;
  if (typeof obj.currentVersion !== 'string' || obj.currentVersion === '') {
    return reportShapeDrift('currentVersion not a non-empty string');
  }
  if (obj.targets !== undefined) {
    if (obj.targets === null || typeof obj.targets !== 'object') {
      return reportShapeDrift('targets not object');
    }
    for (const [, target] of Object.entries(obj.targets as Record<string, unknown>)) {
      if (target === null || target === undefined) continue;
      if (typeof target !== 'object') return reportShapeDrift('target entry not object');
      const t = target as Record<string, unknown>;
      if (typeof t.version !== 'string' || t.version === '') {
        return reportShapeDrift('target.version not a non-empty string');
      }
    }
  }
  return obj as unknown as SkillInstallStateSnapshot;
}

function reportShapeDrift(reason: string): null {
  if (!warnedFetchShapeDrift) {
    warnedFetchShapeDrift = true;
    console.warn(
      `[claude-desktop-integration] ${INSTALL_STATE_PATH} response failed shape validation (${reason}) — falling back to localStorage guard`,
    );
  }
  return null;
}

export function defaultReadLocalStorageGuard(): LocalStorageGuardResult {
  if (typeof localStorage === 'undefined') {
    return { skillInstalled: false, skillVersion: null };
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(GUARD_KEY_PREFIX)) {
        return {
          skillInstalled: true,
          skillVersion: key.slice(GUARD_KEY_PREFIX.length),
        };
      }
    }
  } catch (err) {
    // Sandboxed iframes / private browsing can throw on any access.
    if (!warnedLocalStorageThrew) {
      warnedLocalStorageThrew = true;
      console.warn(
        '[claude-desktop-integration] localStorage scan threw — falling back to skillInstalled=false',
        err,
      );
    }
  }
  return { skillInstalled: false, skillVersion: null };
}

function defaultDeps(): ProbeDeps {
  return {
    detectClaudeDesktop: defaultDetectClaudeDesktop(),
    fetchSnapshot: createDefaultFetchSnapshot(),
    readLocalStorageGuard: defaultReadLocalStorageGuard,
  };
}

interface UseClaudeDesktopIntegrationResult extends ClaudeDesktopIntegrationState {
  /** Re-runs both probes. Discardable. */
  refresh: () => void;
}

export function useClaudeDesktopIntegration(): UseClaudeDesktopIntegrationResult {
  const state = useSyncExternalStore(
    subscribeClaudeDesktopIntegration,
    getClaudeDesktopIntegrationSnapshot,
    getClaudeDesktopIntegrationSnapshot,
  );

  // Kick off initial probe if no cache yet. The coalescer dedups concurrent
  // calls so this is safe to fire from many simultaneous consumers.
  //
  // Window-level focus + storage listeners are NOT registered here — they
  // attach once at the first `subscribeClaudeDesktopIntegration` and detach
  // when the last subscriber unsubscribes (see the refcounted helpers near
  // the top of this file). With four consumer surfaces this avoids stacking
  // four listener pairs onto `window` for what is fundamentally a single
  // shared store.
  useEffect(() => {
    if (!cache) void runIntegrationProbe(defaultDeps());
  }, []);

  return {
    desktopPresent: state?.desktopPresent ?? true,
    skillInstalled: state?.skillInstalled ?? false,
    skillVersion: state?.skillVersion ?? null,
    refresh: () => {
      void runIntegrationProbe(defaultDeps());
    },
  };
}
