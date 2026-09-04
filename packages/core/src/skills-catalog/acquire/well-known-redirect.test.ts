import { describe, expect, test } from 'vitest';
import { readWellKnownIndex } from './well-known.ts';

const ORIGIN = 'https://skills.example.com';

const redirectTo = (location: string | null, status = 302): Response =>
  new Response(null, {
    status,
    headers: location === null ? {} : { location },
  });

function trackingFetch(handler: (url: string) => Response): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('fetchWithinOrigin (via readWellKnownIndex)', () => {
  test('refuses an https → http downgrade instead of following it', async () => {
    const { fetchImpl, urls } = trackingFetch(() =>
      redirectTo('http://skills.example.com/.well-known/agent-skills/index.json'),
    );

    await expect(readWellKnownIndex(ORIGIN, { fetchImpl })).rejects.toThrow(/left the origin/);
    expect(urls.some((u) => u.startsWith('http://'))).toBe(false);
  });

  test('refuses a cross-origin hop, including to a link-local address', async () => {
    for (const target of [
      'https://evil.example.com/index.json',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.7:8080/admin',
    ]) {
      const { fetchImpl, urls } = trackingFetch(() => redirectTo(target));
      await expect(readWellKnownIndex(ORIGIN, { fetchImpl })).rejects.toThrow(/left the origin/);
      expect(urls.some((u) => u.startsWith(new URL(target).origin))).toBe(false);
    }
  });

  test('refuses a redirect that carries no location', async () => {
    const { fetchImpl } = trackingFetch(() => redirectTo(null));
    await expect(readWellKnownIndex(ORIGIN, { fetchImpl })).rejects.toThrow(/carried no location/);
  });

  test('refuses a location that is not a resolvable URL', async () => {
    const { fetchImpl } = trackingFetch(() => redirectTo('http://[not a url'));
    await expect(readWellKnownIndex(ORIGIN, { fetchImpl })).rejects.toThrow(/not a URL/);
  });

  test('caps a same-origin redirect loop rather than following it forever', async () => {
    let n = 0;
    const { fetchImpl, urls } = trackingFetch(() => redirectTo(`${ORIGIN}/hop-${n++}.json`));

    await expect(readWellKnownIndex(ORIGIN, { fetchImpl })).rejects.toThrow(
      /exceeded \d+ redirects/,
    );
    expect(urls.length).toBeLessThanOrEqual(12);
  });

  test('DOES follow a same-origin https hop and returns the final body', async () => {
    const index = {
      basePath: '/.well-known/agent-skills',
      skills: [{ name: 'grill-me', description: 'x', files: ['SKILL.md'] }],
    };
    const { fetchImpl } = trackingFetch((url) =>
      url.includes('/moved/')
        ? new Response(JSON.stringify(index), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : redirectTo(`${ORIGIN}/moved/index.json`),
    );

    const result = await readWellKnownIndex(ORIGIN, { fetchImpl });
    expect(result.skills.map((s) => s.name)).toEqual(['grill-me']);
  });
});

describe('origin admission', () => {
  test('refuses a non-https or credentialed origin outright', async () => {
    const { fetchImpl } = trackingFetch(() => new Response('{}', { status: 200 }));
    for (const bad of ['http://skills.example.com', 'https://user:pw@skills.example.com']) {
      await expect(readWellKnownIndex(bad, { fetchImpl })).rejects.toThrow(/credential-free HTTPS/);
    }
  });
});
