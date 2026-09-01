interface RfcProblemBody {
  title?: unknown;
  detail?: unknown;
}

export function parseApiError(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const candidate = body as RfcProblemBody;
  if (typeof candidate.title === 'string' && candidate.title.length > 0) {
    return candidate.title;
  }
  return undefined;
}
