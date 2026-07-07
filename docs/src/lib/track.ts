import { after } from 'next/server';

/**
 * Server-side PostHog capture for the download/update redirect routes.
 *
 * Reuses the existing `NEXT_PUBLIC_POSTHOG_KEY` (the same project the
 * client-side `instrumentation-client.ts` writes to) — no new env, no
 * `posthog-node` dependency. Capturing from the server, not the browser,
 * means PostHog never sees the visitor's IP (it sees Vercel's egress IP);
 * the payload additionally suppresses geo so nothing location-shaped is
 * stored. Events are queued via `after()` so a slow or failing capture can
 * never delay or break the redirect the user is waiting on.
 */

const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/capture/';
const CAPTURE_TIMEOUT_MS = 3_000;

export interface TrackOptions {
  event: string;
  distinctId: string;
  /** Omitted (undefined) values are stripped so they never serialize as "undefined". */
  properties?: Record<string, string | undefined>;
}

export interface CapturePayload {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

/**
 * Pure payload builder (the unit-testable seam). Strips undefined props and
 * forces the two privacy guards: `$ip: null` discards the (Vercel egress) IP
 * server-side, and `$geoip_disable` stops PostHog deriving geo from it.
 */
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

/**
 * Fire-and-forget event capture. No-ops when the key is unset (mirrors
 * `instrumentation-client.ts`, so local/preview without the key stay silent).
 * Never throws and never blocks the response: the POST runs in `after()` and
 * any failure is swallowed.
 */
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
        // fetch only rejects on network failure; a 4xx/5xx (bad key, rate limit)
        // resolves normally, so surface it rather than silently dropping events.
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
    // Telemetry must never break a redirect — guard the synchronous path too
    // (e.g. after() called outside a request scope, or any scheduling error).
    console.warn(
      `[track] capture skipped for ${opts.event}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reuse the web visitor's PostHog id when present so a site click and its
 * download are one person, then fall back to a fresh random id for hits with
 * no browser session (README/HN links, the auto-updater). `posthog-js` stores
 * its persistence under `ph_<projectKey>_posthog` as JSON `{ distinct_id }`.
 */
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

/**
 * Coarse referrer for the `referrer` property: hostname only, so a referring
 * path is never sent to PostHog. Missing or unparseable referer → omitted.
 */
export function referrerHostname(request: Request): string | undefined {
  const referer = request.headers.get('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).hostname;
  } catch {
    return undefined;
  }
}
