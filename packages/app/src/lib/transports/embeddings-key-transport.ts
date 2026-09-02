import {
  type LocalOpEmbeddingsTestResponse,
  LocalOpEmbeddingsTestResponseSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';

export interface EmbeddingsKeyTransport {
  setKey(key: string): Promise<{ ok: true } | { ok: false; error?: string }>;
  clearKey(): Promise<{ ok: true } | { ok: false; error?: string }>;
  testConnection(): Promise<LocalOpEmbeddingsTestResponse | null>;
}

async function extractProblemTitle(res: Response): Promise<string | undefined> {
  try {
    const result = ProblemDetailsSchema.safeParse(await res.json());
    if (result.success) return result.data.title;
  } catch {}
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
