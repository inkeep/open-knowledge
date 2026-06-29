import { after } from 'next/server';


const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/capture/';
const CAPTURE_TIMEOUT_MS = 3_000;

export interface TrackOptions {
  event: string;
  distinctId: string;
  properties?: Record<string, string | undefined>;
}

export interface CapturePayload {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export function buildCapturePayload(opts: TrackOptions, key: string): CapturePayload {
  const properties: Record<string, unknown> = {};
  if (opts.properties) {
    for (const [k, v] of Object.entries(opts.properties)) {
      if (v !== undefined) properties[k] = v;
    }
  }
  properties.$ip = null;
  properties.$geoip_disable = true;
  return {
    api_key: key,
    event: opts.event,
    distinct_id: opts.distinctId,
    timestamp: new Date().toISOString(),
    properties,
  };
}

export function captureServerEvent(opts: TrackOptions): void {
  try {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    const payload = buildCapturePayload(opts, key);
    after(async () => {
      try {
        const res = await fetch(POSTHOG_CAPTURE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.warn(`[track] capture HTTP ${res.status} for ${opts.event}`);
        }
      } catch (err) {
        console.warn(
          `[track] capture failed for ${opts.event}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  } catch (err) {
    console.warn(
      `[track] capture skipped for ${opts.event}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function resolveDistinctId(request: Request): string {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key) {
    const fromCookie = readPosthogDistinctId(request, key);
    if (fromCookie) return fromCookie;
  }
  return crypto.randomUUID();
}

function readPosthogDistinctId(request: Request, key: string): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const cookieName = `ph_${key}_posthog`;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    try {
      const parsed = JSON.parse(decodeURIComponent(part.slice(eq + 1).trim())) as {
        distinct_id?: unknown;
      };
      return typeof parsed.distinct_id === 'string' && parsed.distinct_id.length > 0
        ? parsed.distinct_id
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function referrerHostname(request: Request): string | undefined {
  const referer = request.headers.get('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).hostname;
  } catch {
    return undefined;
  }
}
