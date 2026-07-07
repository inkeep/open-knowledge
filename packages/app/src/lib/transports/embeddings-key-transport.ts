/**
 * Transport for setting / clearing the machine-global embeddings API key from
 * the Settings → Account UI.
 *
 * HTTP-only: Settings renders only in the editor window (which has the loopback
 * API server), so — unlike the GitHub-auth transport — there's no IPC variant.
 * The key travels renderer → loopback `POST /api/local-op/embeddings/set-key`
 * body → the server's 0600 `~/.ok/secrets.yml`. The key is never returned;
 * presence is read separately via `GET /api/semantic-status` (`keyPresent`).
 *
 * Caller-injected (defaults to the HTTP impl) so the section's DOM tests drive
 * it with a stub — the same pattern as `AuthQueryTransport`.
 */

import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';

export interface EmbeddingsKeyTransport {
  /** Store the key in the secrets file. */
  setKey(key: string): Promise<{ ok: true } | { ok: false; error?: string }>;
  /** Remove the stored key. */
  clearKey(): Promise<{ ok: true } | { ok: false; error?: string }>;
}

// Surfaces the typed RFC 9457 title (loopback-required, invalid-origin, etc.).
// Mirrors `auth-query-transport.ts` so the transports stay a cohesive family.
async function extractProblemTitle(res: Response): Promise<string | undefined> {
  try {
    const result = ProblemDetailsSchema.safeParse(await res.json());
    if (result.success) return result.data.title;
  } catch {
    /* non-JSON / empty body — caller falls back to a generic message */
  }
  return undefined;
}

async function post(
  url: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? { ok: true } : { ok: false, error: await extractProblemTitle(res) };
  } catch {
    return { ok: false };
  }
}

export function httpEmbeddingsKeyTransport(): EmbeddingsKeyTransport {
  return {
    setKey: (key) => post('/api/local-op/embeddings/set-key', { key }),
    clearKey: () => post('/api/local-op/embeddings/clear-key', {}),
  };
}
