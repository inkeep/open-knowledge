/**
 * Transport for the embeddings local-op routes the Settings UI drives: setting
 * / clearing the API key for the project's configured endpoint, and probing it.
 *
 * HTTP-only: Settings renders only in the editor window (which has the loopback
 * API server), so — unlike the GitHub-auth transport — there's no IPC variant.
 * The key travels renderer → loopback `POST /api/local-op/embeddings/set-key`
 * body → the server's 0600 `~/.ok/secrets.yml`. The server binds it to THIS
 * project + its configured endpoint (derived server-side, never from the body).
 * The key is never returned; presence is read via `GET /api/semantic-status`.
 *
 * Caller-injected (defaults to the HTTP impl) so the sections' DOM tests drive
 * it with a stub — the same pattern as `AuthQueryTransport`.
 */

import {
  type LocalOpEmbeddingsTestResponse,
  LocalOpEmbeddingsTestResponseSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';

export interface EmbeddingsKeyTransport {
  /** Store the key in the secrets file. */
  setKey(key: string): Promise<{ ok: true } | { ok: false; error?: string }>;
  /** Remove the stored key. */
  clearKey(): Promise<{ ok: true } | { ok: false; error?: string }>;
  /**
   * Probe the SAVED endpoint with one throwaway embed. Resolves `null` when the
   * request itself couldn't be made — distinct from a probe that reached a
   * verdict, which comes back as the route's discriminated result.
   */
  testConnection(): Promise<LocalOpEmbeddingsTestResponse | null>;
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
    async testConnection() {
      try {
        const res = await fetch('/api/local-op/embeddings/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) return null;
        const parsed = LocalOpEmbeddingsTestResponseSchema.safeParse(await res.json());
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
