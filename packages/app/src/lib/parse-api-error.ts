interface RfcProblemBody {
  type?: unknown;
  contentControlAdmission?: unknown;
  title?: unknown;
  detail?: unknown;
}

export function parseApiError(body: unknown, includeDetail = false): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const candidate = body as RfcProblemBody;
  if (typeof candidate.title === 'string' && candidate.title.length > 0) {
    if (
      includeDetail &&
      candidate.type === 'urn:ok:error:invalid-request' &&
      candidate.contentControlAdmission === true &&
      typeof candidate.detail === 'string' &&
      candidate.detail.length > 0
    ) {
      return `${candidate.title} (${candidate.detail})`;
    }
    return candidate.title;
  }
  return undefined;
}
