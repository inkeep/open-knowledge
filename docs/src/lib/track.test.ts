import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  attribution,
  buildCapturePayload,
  captureServerEvent,
  isPrefetchRequest,
  resolveDistinctId,
  userAgentProperties,
} from './track.ts';

const KEY = 'phc_test_key';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const prevKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
afterEach(() => {
  if (prevKey === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  else process.env.NEXT_PUBLIC_POSTHOG_KEY = prevKey;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://openknowledge.ai/download/stable', { headers });
}

describe('buildCapturePayload', () => {
  test('forces the privacy guards and strips undefined props', () => {
    const p = buildCapturePayload(
      {
        event: 'dmg_downloaded',
        distinctId: 'd1',
        properties: { channel: 'stable', from_version: undefined },
      },
      KEY,
    );
    expect(p.api_key).toBe(KEY);
    expect(p.event).toBe('dmg_downloaded');
    expect(p.distinct_id).toBe('d1');
    expect(typeof p.timestamp).toBe('string');
    expect(p.properties.channel).toBe('stable');
    expect('from_version' in p.properties).toBe(false);
    // privacy guards
    expect(p.properties.$ip).toBeNull();
    expect(p.properties.$geoip_disable).toBe(true);
    // the builder never injects request-shape properties itself — routes opt
    // in explicitly via userAgentProperties()
    expect('$useragent' in p.properties).toBe(false);
  });
});

describe('resolveDistinctId', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = KEY;
  });

  test('reuses the posthog cookie distinct_id when present', () => {
    const cookie = `ph_${KEY}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: 'abc-123' }))}`;
    expect(resolveDistinctId(req({ cookie }))).toBe('abc-123');
  });

  test('falls back to a random UUID when no cookie', () => {
    expect(resolveDistinctId(req())).toMatch(UUID_RE);
  });

  test('falls back to a random UUID on a malformed cookie (no throw)', () => {
    const cookie = `ph_${KEY}_posthog=not-json`;
    expect(resolveDistinctId(req({ cookie }))).toMatch(UUID_RE);
  });

  test('falls back to a random UUID on an empty distinct_id', () => {
    const cookie = `ph_${KEY}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: '' }))}`;
    expect(resolveDistinctId(req({ cookie }))).toMatch(UUID_RE);
  });

  test('finds the posthog cookie among multiple cookies', () => {
    const ph = encodeURIComponent(JSON.stringify({ distinct_id: 'abc-456' }));
    const cookie = `_ga=GA1.1; ph_${KEY}_posthog=${ph}; session=xyz`;
    expect(resolveDistinctId(req({ cookie }))).toBe('abc-456');
  });

  test('ignores cookies and returns a UUID when the key is unset', () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const cookie = `ph_${KEY}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: 'abc-123' }))}`;
    expect(resolveDistinctId(req({ cookie }))).toMatch(UUID_RE);
  });
});

function reqUrl(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe('attribution', () => {
  test('captures utm_content from our own CTA links', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable?utm_content=landing-hero'),
    );
    expect(a.utm_content).toBe('landing-hero');
  });

  test('captures the full standard UTM set from external campaign links', () => {
    const a = attribution(
      reqUrl(
        'https://openknowledge.ai/download/stable?utm_source=newsletter&utm_medium=email&utm_campaign=Launch%20Week&utm_content=header-button&utm_term=knowledge%20base',
      ),
    );
    expect(a.utm_source).toBe('newsletter');
    expect(a.utm_medium).toBe('email');
    expect(a.utm_campaign).toBe('Launch Week');
    expect(a.utm_content).toBe('header-button');
    expect(a.utm_term).toBe('knowledge base');
  });

  test('sanitizes utm values: control chars stripped, length capped, empty dropped', () => {
    const a = attribution(
      reqUrl(
        `https://openknowledge.ai/download/stable?utm_content=${'a'.repeat(150)}&utm_source=%00%01ok%7f&utm_medium=%20%20`,
      ),
    );
    expect(a.utm_content).toBe('a'.repeat(100));
    expect(a.utm_source).toBe('ok');
    expect(a.utm_medium).toBeUndefined();
  });

  test('external referrer: hostname only, no path', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', {
        referer: 'https://news.ycombinator.com/item?id=1',
      }),
    );
    expect(a.referrer).toBe('news.ycombinator.com');
    expect(a.referrer_path).toBeUndefined();
  });

  test('missing or unparseable referer: no referrer properties', () => {
    expect(
      attribution(reqUrl('https://openknowledge.ai/download/stable')).referrer,
    ).toBeUndefined();
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', { referer: 'not a url' }),
    );
    expect(a.referrer).toBeUndefined();
    expect(a.referrer_path).toBeUndefined();
  });

  test('own-site referrer: hostname plus page path, never the query string', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', {
        referer: 'https://openknowledge.ai/docs/get-started/quickstart?token=secret',
      }),
    );
    expect(a.referrer).toBe('openknowledge.ai');
    expect(a.referrer_path).toBe('/docs/get-started/quickstart');
  });

  test('own-site subdomain referrer also gets a path', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', {
        referer: 'https://www.openknowledge.ai/',
      }),
    );
    expect(a.referrer_path).toBe('/');
  });

  test('own-site /d/<encoded> share referrer: hostname only, path suppressed', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', {
        referer: 'https://openknowledge.ai/d/aHR0cHM6Ly9naXRodWIuY29t',
      }),
    );
    expect(a.referrer).toBe('openknowledge.ai');
    expect(a.referrer_path).toBeUndefined();
  });

  test('own-site referrer path is capped at 200 chars', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', {
        referer: `https://openknowledge.ai/docs/${'x'.repeat(400)}`,
      }),
    );
    expect(a.referrer_path?.length).toBe(200);
  });

  test('a lookalike domain is treated as external', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', {
        referer: 'https://notopenknowledge.ai/phish',
      }),
    );
    expect(a.referrer).toBe('notopenknowledge.ai');
    expect(a.referrer_path).toBeUndefined();
  });

  test('sec-fetch-site passes through only known values', () => {
    const ok = attribution(
      reqUrl('https://openknowledge.ai/download/stable', { 'sec-fetch-site': 'cross-site' }),
    );
    expect(ok.sec_fetch_site).toBe('cross-site');
    const junk = attribution(
      reqUrl('https://openknowledge.ai/download/stable', { 'sec-fetch-site': 'evil' }),
    );
    expect(junk.sec_fetch_site).toBeUndefined();
    expect(
      attribution(reqUrl('https://openknowledge.ai/download/stable')).sec_fetch_site,
    ).toBeUndefined();
  });

  test('includes the user-agent properties', () => {
    const a = attribution(
      reqUrl('https://openknowledge.ai/download/stable', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
      }),
    );
    expect(a.$useragent).toBe('Mozilla/5.0 (Macintosh) Safari/605.1.15');
    expect(a.ua_class).toBe('browser');
  });
});

describe('userAgentProperties', () => {
  const UA_URL = 'https://openknowledge.ai/download/stable';
  function classify(ua: string): string | undefined {
    return userAgentProperties(reqUrl(UA_URL, { 'user-agent': ua })).ua_class;
  }

  test('classifies browsers, bots, cli clients, and electron', () => {
    expect(classify('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15')).toBe(
      'browser',
    );
    expect(classify('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('bot');
    expect(classify('Slackbot-LinkExpanding 1.0')).toBe('bot');
    expect(classify('curl/8.4.0')).toBe('cli');
    expect(classify('Wget/1.21')).toBe('cli');
    expect(classify('electron-updater/6.3.0')).toBe('electron');
    expect(
      classify('Mozilla/5.0 OpenKnowledge/0.24.0 Chrome/128.0.0.0 Electron/32.1.0 Safari/537.36'),
    ).toBe('electron');
    expect(classify('SomethingUnrecognized/1.0')).toBe('other');
  });

  test('missing UA classifies as none with no $useragent', () => {
    const p = userAgentProperties(reqUrl(UA_URL));
    expect(p.ua_class).toBe('none');
    expect(p.$useragent).toBeUndefined();
  });

  test('caps the raw UA length', () => {
    const p = userAgentProperties(reqUrl(UA_URL, { 'user-agent': `Mozilla/${'x'.repeat(500)}` }));
    expect(p.$useragent?.length).toBe(300);
  });
});

describe('isPrefetchRequest', () => {
  const ROUTE_URL = 'https://openknowledge.ai/download/stable';
  test('true for browser and framework prefetch signals', () => {
    expect(isPrefetchRequest(reqUrl(ROUTE_URL, { 'sec-purpose': 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(reqUrl(ROUTE_URL, { 'sec-purpose': 'prefetch;prerender' }))).toBe(
      true,
    );
    expect(isPrefetchRequest(reqUrl(ROUTE_URL, { purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(reqUrl(ROUTE_URL, { 'next-router-prefetch': '1' }))).toBe(true);
  });
  test('false for ordinary requests', () => {
    expect(isPrefetchRequest(reqUrl(ROUTE_URL))).toBe(false);
    expect(isPrefetchRequest(reqUrl(ROUTE_URL, { 'sec-fetch-site': 'none' }))).toBe(false);
  });
});

describe('captureServerEvent', () => {
  test('no-ops (no fetch) when the key is unset', () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null);
    }) as typeof fetch;
    try {
      captureServerEvent({ event: 'dmg_downloaded', distinctId: 'd1' });
    } finally {
      globalThis.fetch = orig;
    }
    expect(called).toBe(false);
  });

  test('never throws even when scheduling fails (key set, no request scope)', () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = KEY;
    // after() throws outside a request scope — captureServerEvent must swallow it
    // so a redirect is never broken by telemetry.
    expect(() => captureServerEvent({ event: 'dmg_downloaded', distinctId: 'd1' })).not.toThrow();
  });
});
