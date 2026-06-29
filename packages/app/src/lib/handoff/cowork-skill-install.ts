import { defaultSkillInstaller, type SkillInstaller } from '@/lib/handoff/skill-installer';
import '@/lib/desktop-bridge-types';

/** Storage seam — `Pick`-equivalent of `Storage` so callers can inject
 * in-memory doubles without implementing the full DOM Storage shape. */
export interface SkillInstallStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Shape of `GET /api/skill/install-state` response. Mirrors the server's
 * `SkillInstallStateSnapshot` (in `@inkeep/open-knowledge-server`). */
interface SkillInstallStateSnapshotShape {
  currentVersion: string;
  targets: Partial<
    Record<'claude-cowork' | 'cli-hosts', { version: string; recordedAt: string } | null>
  >;
}

export type EnsureCoworkSkillOutcome =
  | { kind: 'already-installed'; source: 'server' | 'local' }
  | { kind: 'installed-now'; path?: string; handoffWarning?: string }
  | { kind: 'host-unsupported' }
  | { kind: 'install-failed'; reason: string; message?: string };

interface EnsureCoworkSkillOptions {
  force?: boolean;
}

export interface EnsureCoworkSkillDeps {
  readonly installer?: SkillInstaller | null;
  readonly storage?: SkillInstallStorage | null;
  readonly fetchSnapshot?: () => Promise<SkillInstallStateSnapshotShape | null>;
  readonly serverTimeoutMs?: number;
  readonly fallbackSkillVersion?: string;
}

const GUARD_KEY_PREFIX = 'ok:skill:cowork:installed';
const GUARD_VALUE = '1';
const DEFAULT_SERVER_TIMEOUT_MS = 250;
const INSTALL_STATE_PATH = '/api/skill/install-state';

export function buildCoworkSkillGuardKey(skillVersion: string): string {
  return `${GUARD_KEY_PREFIX}:v${skillVersion}`;
}

const INFLIGHT: Map<string, Promise<EnsureCoworkSkillOutcome>> = new Map();

export async function ensureCoworkSkillInstalled(
  deps: EnsureCoworkSkillDeps = {},
  opts: EnsureCoworkSkillOptions = {},
): Promise<EnsureCoworkSkillOutcome> {
  const cacheKey = opts.force ? '__force__' : '__default__';
  const existing = INFLIGHT.get(cacheKey);
  if (existing) return existing;

  const promise = runEnsure(deps, opts);
  INFLIGHT.set(cacheKey, promise);
  promise.finally(() => {
    if (INFLIGHT.get(cacheKey) === promise) INFLIGHT.delete(cacheKey);
  });
  return promise;
}

async function runEnsure(
  deps: EnsureCoworkSkillDeps,
  opts: EnsureCoworkSkillOptions,
): Promise<EnsureCoworkSkillOutcome> {
  const installer = deps.installer === undefined ? defaultSkillInstaller() : deps.installer;
  const storage = resolveStorage(deps.storage);
  const fetchSnapshot = deps.fetchSnapshot ?? defaultFetchSnapshot;
  const timeoutMs = deps.serverTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;

  let snapshot: SkillInstallStateSnapshotShape | null = null;
  if (!opts.force) {
    try {
      snapshot = await raceTimeout(fetchSnapshot(), timeoutMs);
    } catch (err) {
      console.warn('[cowork-skill] server install-state check failed; falling through:', err);
    }
    if (snapshot) {
      const recorded = snapshot.targets['claude-cowork'] ?? null;
      if (recorded && recorded.version === snapshot.currentVersion) {
        return { kind: 'already-installed', source: 'server' };
      }
    }
  }

  const guardVersion =
    snapshot?.currentVersion ?? deps.fallbackSkillVersion ?? defaultFallbackSkillVersion();
  const key = buildCoworkSkillGuardKey(guardVersion);
  if (!opts.force && storage?.getItem(key) === GUARD_VALUE) {
    return { kind: 'already-installed', source: 'local' };
  }

  if (!installer) {
    return { kind: 'host-unsupported' };
  }

  const result = await installer.install({ force: opts.force ?? false });
  if (!result.ok) {
    return { kind: 'install-failed', reason: result.reason, message: result.message };
  }

  try {
    storage?.setItem(key, GUARD_VALUE);
  } catch (err) {
    console.warn('[cowork-skill] storage.setItem failed (guard will not persist):', err);
  }

  return {
    kind: 'installed-now',
    path: result.path,
    handoffWarning: result.handoffWarning,
  };
}

function resolveStorage(
  injected: SkillInstallStorage | null | undefined,
): SkillInstallStorage | null {
  if (injected !== undefined) return injected;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultFallbackSkillVersion(): string {
  if (typeof window === 'undefined') return 'unknown';
  return window.okDesktop?.appVersion ?? 'unknown';
}

async function defaultFetchSnapshot(): Promise<SkillInstallStateSnapshotShape | null> {
  let response: Response;
  try {
    response = await fetch(INSTALL_STATE_PATH, { method: 'GET', cache: 'no-store' });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const body = (await response.json()) as SkillInstallStateSnapshotShape;
    if (typeof body?.currentVersion !== 'string') return null;
    return body;
  } catch {
    return null;
  }
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
}

export function ensureCoworkSkillInstalledWithDefaults(
  opts?: EnsureCoworkSkillOptions,
): Promise<EnsureCoworkSkillOutcome> {
  return ensureCoworkSkillInstalled({}, opts);
}

export function reinstallCoworkSkill(): Promise<EnsureCoworkSkillOutcome> {
  return ensureCoworkSkillInstalled({}, { force: true });
}
