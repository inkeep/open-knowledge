import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildCapturePayload,
  captureServerEvent,
  referrerHostname,
  resolveDistinctId,
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
    // never carries identifying request shape
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

describe('referrerHostname', () => {
  test('returns hostname only (never the path)', () => {
    expect(referrerHostname(req({ referer: 'https://news.ycombinator.com/item?id=1' }))).toBe(
      'news.ycombinator.com',
    );
  });
  test('undefined when missing or unparseable', () => {
    expect(referrerHostname(req())).toBeUndefined();
    expect(referrerHostname(req({ referer: 'not a url' }))).toBeUndefined();
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
