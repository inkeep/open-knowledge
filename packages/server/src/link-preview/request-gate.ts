/**
 * Why a request was refused, so the caller can pick the right problem type.
 * @lintignore Referenced by the exported LinkPreviewGateVerdict type; no direct importer.
 */
export type LinkPreviewGateRejection = 'origin' | 'content-type';

export type LinkPreviewGateVerdict = { ok: true } | { ok: false; reason: LinkPreviewGateRejection };

export function isLoopbackHttpOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return base === 'application/json';
}

export function classifyLinkPreviewRequest(headers: {
  origin: string | undefined;
  contentType: string | undefined;
}): LinkPreviewGateVerdict {
  if (!isLoopbackHttpOrigin(headers.origin)) return { ok: false, reason: 'origin' };
  if (!isJsonContentType(headers.contentType)) return { ok: false, reason: 'content-type' };
  return { ok: true };
}
