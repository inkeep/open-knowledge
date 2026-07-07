import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { proxy } from './proxy.ts';

/**
 * Apple's `swcd` fetches the App Site Association file WITHOUT following
 * redirects and negative-caches a failure for ~8 days. The desktop entitlement
 * declares `applinks:openknowledge.ai` AND `applinks:www.openknowledge.ai`, so
 * BOTH hosts must serve `/.well-known/apple-app-site-association` as a direct
 * 200 — never a redirect. These tests pin that carve-out alongside the
 * www -> apex canonicalization that applies to every other path.
 */
function run(host: string, pathAndQuery: string) {
  const req = new NextRequest(`https://${host}${pathAndQuery}`, { headers: { host } });
  return proxy(req);
}

const APEX = 'openknowledge.ai';
const WWW = 'www.openknowledge.ai';
const AASA = '/.well-known/apple-app-site-association';

describe('proxy: www -> apex canonicalization', () => {
  test('www + AASA passes through (no redirect) so Apple gets a direct 200', () => {
    const res = run(WWW, AASA);
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('the whole /.well-known/* prefix is excluded on www, not just AASA', () => {
    const res = run(WWW, '/.well-known/assetlinks.json');
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('www + a normal page redirects 308 to apex', () => {
    const res = run(WWW, '/docs/get-started/quickstart');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://${APEX}/docs/get-started/quickstart`);
  });

  test('www + root redirects 308 to apex root', () => {
    const res = run(WWW, '/');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://${APEX}/`);
  });

  test('www redirect preserves the query string', () => {
    const res = run(WWW, '/d/abc123?ref=slack');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://${APEX}/d/abc123?ref=slack`);
  });

  test('apex + a normal page is untouched (no redirect)', () => {
    const res = run(APEX, '/docs/get-started/quickstart');
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('apex + AASA is untouched (the working host stays working)', () => {
    const res = run(APEX, AASA);
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('preview/other hosts are not canonicalized to apex', () => {
    const res = run('open-knowledge-git-feat.vercel.app', '/docs');
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });
});
