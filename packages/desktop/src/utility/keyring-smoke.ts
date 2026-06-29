
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
      }
    }
  }
}
