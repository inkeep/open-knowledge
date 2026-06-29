
import { useEffect, useSyncExternalStore } from 'react';
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
  readonly detectClaudeDesktop?: (() => Promise<boolean>) | undefined;
  readonly fetchSnapshot: () => Promise<SkillInstallStateSnapshot | null>;
  readonly readLocalStorageGuard: () => LocalStorageGuardResult;
}

const COWORK_TARGET = 'claude-cowork';
const GUARD_KEY_PREFIX = 'ok:skill:cowork:installed:v';
const SKILL_STATE_FETCH_TIMEOUT_MS = 250;
const INSTALL_STATE_PATH = '/api/skill/install-state';

let cache: ClaudeDesktopIntegrationState | null = null;
const subscribers = new Set<() => void>();
let inflight: Promise<void> | null = null;

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

let warnedDesktopDetectThrew = false;
let warnedFetchThrew = false;
let warnedFetchTimeout = false;
let warnedFetchNonOk = false;
let warnedJsonParseThrew = false;
let warnedFetchShapeDrift = false;
let warnedLocalStorageThrew = false;

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

export async function runIntegrationProbe(deps: ProbeDeps): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = await probeClaudeDesktopIntegration(deps);
      cache = next;
      for (const cb of subscribers) {
        try {
          cb();
        } catch (err) {
          console.error('[claude-desktop-integration] subscriber threw', err);
        }
      }
    } catch (err) {
      console.error('[claude-desktop-integration] probe rejected unexpectedly', err);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function resetClaudeDesktopIntegrationForTest(): void {
  cache = null;
  subscribers.clear();
  inflight = null;
  detachWindowListeners();
  warnedDesktopDetectThrew = false;
  warnedFetchThrew = false;
  warnedFetchTimeout = false;
  warnedFetchNonOk = false;
  warnedJsonParseThrew = false;
  warnedFetchShapeDrift = false;
  warnedLocalStorageThrew = false;
}

export function peekClaudeDesktopIntegrationCache(): ClaudeDesktopIntegrationState | null {
  return cache;
}

/** Register a `useSyncExternalStore`-compatible subscriber. The handler is
 *  invoked with no arguments whenever a probe completes; the consumer calls
 *  `getClaudeDesktopIntegrationSnapshot()` (or the hook resolves via the
 *  store contract) to read the new value. Returns an unsubscribe function. */
export function subscribeClaudeDesktopIntegration(handler: () => void): () => void {
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
  refresh: () => void;
}

export function useClaudeDesktopIntegration(): UseClaudeDesktopIntegrationResult {
  const state = useSyncExternalStore(
    subscribeClaudeDesktopIntegration,
    getClaudeDesktopIntegrationSnapshot,
    getClaudeDesktopIntegrationSnapshot,
  );

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
