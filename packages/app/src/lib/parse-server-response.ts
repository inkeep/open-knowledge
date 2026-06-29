
import type { z } from 'zod';
import { parseApiError } from './parse-api-error.ts';

export async function parseServerResponse(
  res: Response,
  fallbackErrorTitle: string,
): Promise<{ ok: true; body: unknown } | { ok: false; title: string }> {
  let body: unknown = null;
  let parseErr: unknown;
  try {
    body = await res.json();
  } catch (err) {
    parseErr = err;
  }
  if (parseErr instanceof Error && parseErr.name === 'AbortError') {
    throw parseErr;
  }
  if (res.ok) {
    if (parseErr !== undefined) {
      console.warn(
        '[parse-server-response] 2xx response with non-JSON body:',
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
    }
    return { ok: true, body: parseErr === undefined ? body : null };
  }
  if (parseErr !== undefined) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return { ok: false, title: `Server error (HTTP ${res.status}): ${detail}` };
  }
  return { ok: false, title: parseApiError(body) ?? fallbackErrorTitle };
}

export function parseSuccessOrWarn<TIn, TOut>(
  schema: z.ZodType<TIn>,
  body: unknown,
  handler: string,
  fallback: TOut,
): TIn | TOut {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const bodyShape =
    typeof body === 'object' && body !== null
      ? Object.keys(body as Record<string, unknown>)
      : typeof body;
  console.warn(
    '[parse-server-response] schema drift:',
    handler,
    'bodyShape=',
    bodyShape,
    'issues=',
    result.error.issues,
  );
  return fallback;
}
