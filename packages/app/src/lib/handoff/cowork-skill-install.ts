/**
 * Per-host install gate for the OpenKnowledge Agent Skill in Claude Cowork
 * (the Cowork tab of Claude Desktop). Sits between the renderer's "Open in
 * Cowork" click and the actual `.skill` build + upload prompt.
 *
 * Three-step ladder:
 *   1. **Server check (authoritative).** Fetch `GET /api/skill/install-state`
 *      with a short timeout. If the recorded `claude-cowork` version
 *      matches the current bundled skill version, return `'already-installed'`
 *      immediately — no rebuild, no Claude Desktop dialog.
 *   2. **localStorage fallback (offline).** When the server check fails or
 *      its `currentVersion` doesn't match a recorded target, consult the
 *      per-host `localStorage["ok:skill:cowork:installed:v<version>"]` flag
 *      kept by previous installs from this surface.
 *   3. **Install.** Invoke the pluggable `SkillInstaller` (Electron bridge
 *      or HTTP endpoint per host). On success, mirror to localStorage so
 *      a future click on the same surface can short-circuit if the server
 *      ever becomes unreachable.
 *
 * Concurrency:
 *   - Module-level inflight `Promise` cache coalesces rapid double-clicks
 *     per surface. Keyed by `{ force }` so a normal-click and a
 *     reinstall-click don't share a race.
 *   - Cross-surface races (web tab + Electron clicked Cowork at same instant)
 *     are bounded by the server-side atomic write.
 *
 * Reinstall affordance:
 *   - `ensureCoworkSkillInstalled({}, { force: true })` bypasses both gates
 *     and triggers a fresh build + Claude Desktop prompt regardless of
 *     recorded state. The thin wrapper `reinstallCoworkSkill()` is the
 *     UX-facing entry point for the menu item / install-toast retry link.
 */

import { defaultSkillInstaller, type SkillInstaller } from '@/lib/handoff/skill-installer';
// Side-effect import only — loads `Window.okDesktop?` global augmentation.
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

/** Per-call options. `force: true` bypasses both gates. */
interface EnsureCoworkSkillOptions {
  force?: boolean;
}

export interface EnsureCoworkSkillDeps {
  /**
   * Installer to invoke when both gates miss. Pass `null` when no installer
   * can be constructed for the current host (the helper then returns
   * `host-unsupported`); `undefined` resolves to `defaultSkillInstaller()`
   * at call time.
   */
  readonly installer?: SkillInstaller | null;
  /**
   * Storage seam. Defaults to `window.localStorage` when undefined; pass
   * `null` to disable persistence (the guard then never sets and every call
   * invokes the installer — useful for a "reinstall" debug surface).
   */
  readonly storage?: SkillInstallStorage | null;
  /**
   * Snapshot fetcher. Defaults to a same-origin GET against
   * `/api/skill/install-state`. Test-injectable.
   */
  readonly fetchSnapshot?: () => Promise<SkillInstallStateSnapshotShape | null>;
  /**
   * Server-check timeout in ms. Defaults to 250ms. Beyond timeout
   * the ladder falls through to localStorage.
   */
  readonly serverTimeoutMs?: number;
  /**
   * Fallback skill version for the localStorage key when the server is
   * unreachable. Defaults to `window.okDesktop?.appVersion ?? 'unknown'` —
   * matches today's literal-string convention so existing localStorage
   * flags remain readable. Has no effect when the server snapshot
   * resolves successfully.
   */
  readonly fallbackSkillVersion?: string;
}

const GUARD_KEY_PREFIX = 'ok:skill:cowork:installed';
const GUARD_VALUE = '1';
const DEFAULT_SERVER_TIMEOUT_MS = 250;
const INSTALL_STATE_PATH = '/api/skill/install-state';

/** Composes the versioned localStorage key. Exported for assertion in tests. */
export function buildCoworkSkillGuardKey(skillVersion: string): string {
  return `${GUARD_KEY_PREFIX}:v${skillVersion}`;
}

const INFLIGHT: Map<string, Promise<EnsureCoworkSkillOutcome>> = new Map();

/**
 * Run the install ladder. Coalesces concurrent calls with the same `force`
 * flag — a regular click and a reinstall-click execute independently, but
 * two regular clicks within the same animation frame share one in-flight
 * `Promise`.
 */
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

  // Step 1 — server check (skipped when forcing a reinstall).
  let snapshot: SkillInstallStateSnapshotShape | null = null;
  if (!opts.force) {
    try {
      snapshot = await raceTimeout(fetchSnapshot(), timeoutMs);
    } catch (err) {
      // Treated identically to "server unreachable" — fall through.
      // Log so persistent failures (proxy misconfig, malformed body) are
      // diagnosable instead of silently swallowed.
      console.warn('[cowork-skill] server install-state check failed; falling through:', err);
    }
    if (snapshot) {
      const recorded = snapshot.targets['claude-cowork'] ?? null;
      if (recorded && recorded.version === snapshot.currentVersion) {
        return { kind: 'already-installed', source: 'server' };
      }
    }
  }

  // Step 2 — localStorage fallback. Uses the server's `currentVersion` when
  // available, otherwise the host's fallback (preserves pre-spec keys for
  // already-installed users).
  const guardVersion =
    snapshot?.currentVersion ?? deps.fallbackSkillVersion ?? defaultFallbackSkillVersion();
  const key = buildCoworkSkillGuardKey(guardVersion);
  if (!opts.force && storage?.getItem(key) === GUARD_VALUE) {
    return { kind: 'already-installed', source: 'local' };
  }

  // Step 3 — install.
  if (!installer) {
    return { kind: 'host-unsupported' };
  }

  const result = await installer.install({ force: opts.force ?? false });
  if (!result.ok) {
    return { kind: 'install-failed', reason: result.reason, message: result.message };
  }

  // Mirror to localStorage so the next click on this surface can short-circuit
  // even if the server temporarily becomes unreachable. Failures here are
  // non-critical — the server's recorded state is the authoritative source
  // and the next click can fetch it.
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

/**
 * `undefined` → resolve to `window.localStorage` when available, else `null`.
 * `null` → caller explicitly opted out of persistence.
 * `SkillInstallStorage` → caller injected a double.
 */
function resolveStorage(
  injected: SkillInstallStorage | null | undefined,
): SkillInstallStorage | null {
  if (injected !== undefined) return injected;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Some sandboxed iframes throw on `localStorage` access. Fail soft —
    // the install will run every click but no real harm.
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

/**
 * Convenience wrapper for the renderer dispatch hook that matches today's
 * call shape (`(): Promise<Outcome>`). Forwards `opts.force` from the
 * reinstall affordance.
 */
export function ensureCoworkSkillInstalledWithDefaults(
  opts?: EnsureCoworkSkillOptions,
): Promise<EnsureCoworkSkillOutcome> {
  return ensureCoworkSkillInstalled({}, opts);
}

/**
 * Reinstall affordance entry point. Bypasses both gates and forces a
 * fresh build + Claude Desktop upload prompt. Wired through
 * `useHandoffDispatch` so the editor menu / install-toast retry link
 * can call it directly.
 */
export function reinstallCoworkSkill(): Promise<EnsureCoworkSkillOutcome> {
  return ensureCoworkSkillInstalled({}, { force: true });
}
