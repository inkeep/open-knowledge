/**
 * Utility-process keyring smoke — proves that `@napi-rs/keyring` loads and
 * round-trips setPassword/getPassword/deletePassword under the packaged
 * hardened-runtime environment.
 *
 * Pure factory with injectable deps so Bun tests can simulate load-failure,
 * constructor-failure, and read-mismatch without touching the real native
 * binding (Bun's ABI is not Electron's Node-ABI).
 *
 * Key isolation: uses service='open-knowledge-smoke', account='test-user' —
 * distinct from the real auth substrate's service='open-knowledge',
 * account=<host>. Collision-free by construction even if cleanup fails
 * mid-run.
 */

const SMOKE_SERVICE = 'open-knowledge-smoke';
const SMOKE_ACCOUNT = 'test-user';

export interface KeyringSmokeResult {
  ok: boolean;
  backend?: 'keyring' | 'file';
  error?: string;
  durationMs?: number;
  timestamp: string;
}

interface RunKeyringSmokeDeps {
  loadKeyring?: () => Promise<typeof import('@napi-rs/keyring')>;
  now?: () => number;
}

export async function runKeyringSmoke(deps: RunKeyringSmokeDeps = {}): Promise<KeyringSmokeResult> {
  const loadKeyring = deps.loadKeyring ?? (() => import('@napi-rs/keyring'));
  const now = deps.now ?? Date.now;
  const start = now();

  let mod: typeof import('@napi-rs/keyring');
  try {
    mod = await loadKeyring();
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      durationMs: now() - start,
      timestamp: new Date().toISOString(),
    };
  }

  const expected = `smoke-token-${now()}`;
  let entry: import('@napi-rs/keyring').Entry | null = null;
  try {
    entry = new mod.Entry(SMOKE_SERVICE, SMOKE_ACCOUNT);
    entry.setPassword(expected);
    const read = entry.getPassword();
    if (read !== expected) {
      return {
        ok: false,
        error: `read mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(read)}`,
        durationMs: now() - start,
        timestamp: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      backend: 'keyring',
      durationMs: now() - start,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      durationMs: now() - start,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (entry) {
      try {
        entry.deletePassword();
      } catch {
        // best-effort cleanup
      }
    }
  }
}
