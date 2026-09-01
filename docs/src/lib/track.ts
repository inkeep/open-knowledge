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

const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

function sanitizeUtmValue(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = [...raw]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : undefined;
}

const SEC_FETCH_SITE_VALUES = ['none', 'same-origin', 'same-site', 'cross-site'] as const;
type SecFetchSite = (typeof SEC_FETCH_SITE_VALUES)[number];

function isSecFetchSite(value: string): value is SecFetchSite {
  return (SEC_FETCH_SITE_VALUES as readonly string[]).includes(value);
}

export type UaClass = 'browser' | 'bot' | 'cli' | 'electron' | 'none' | 'other';

function isOwnSiteHostname(hostname: string): boolean {
  return hostname === 'openknowledge.ai' || hostname.endsWith('.openknowledge.ai');
}

export interface AttributionProperties {
  referrer?: string;
  referrer_path?: string;
  sec_fetch_site?: SecFetchSite;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  $useragent?: string;
  ua_class?: UaClass;
}

export function attribution(request: Request): AttributionProperties {
  const out: AttributionProperties = {};

  try {
    const params = new URL(request.url).searchParams;
    for (const name of UTM_PARAMS) {
      const value = sanitizeUtmValue(params.get(name));
      if (value) out[name] = value;
    }
  } catch {}

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      out.referrer = refUrl.hostname;
      if (isOwnSiteHostname(refUrl.hostname) && !refUrl.pathname.startsWith('/d/')) {
        out.referrer_path = refUrl.pathname.slice(0, 200);
      }
    } catch {}
  }

  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && isSecFetchSite(secFetchSite)) {
    out.sec_fetch_site = secFetchSite;
  }

  Object.assign(out, userAgentProperties(request));

  return out;
}

export function userAgentProperties(request: Request): {
  $useragent?: string;
  ua_class?: UaClass;
} {
  const ua = request.headers.get('user-agent');
  if (!ua) return { ua_class: 'none' };
  return { $useragent: ua.slice(0, 300), ua_class: classifyUserAgent(ua) };
}

function classifyUserAgent(ua: string): UaClass {
  if (/electron-updater|electron-builder|\belectron\//i.test(ua)) return 'electron';
  if (
    /bot|crawler|spider|slurp|bingpreview|externalhit|embedly|whatsapp|telegram|slack|discord|pinterest|linkedin|vkshare/i.test(
      ua,
    )
  ) {
    return 'bot';
  }
  if (
    /^curl|^wget|^httpie|python-requests|python-urllib|node-fetch|undici|axios|go-http-client|okhttp|java\/|libwww/i.test(
      ua,
    )
  ) {
    return 'cli';
  }
  if (ua.startsWith('Mozilla/')) return 'browser';
  return 'other';
}

export function isPrefetchRequest(request: Request): boolean {
  const purpose = request.headers.get('sec-purpose') ?? request.headers.get('purpose') ?? '';
  if (/prefetch|prerender/i.test(purpose)) return true;
  return request.headers.get('next-router-prefetch') !== null;
}
