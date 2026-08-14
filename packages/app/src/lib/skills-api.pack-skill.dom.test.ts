import { afterEach, describe, expect, test, vi } from 'vitest';
import { installPackSkill } from './skills-api';

const originalFetch = globalThis.fetch;

describe('installPackSkill', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('uses the explicit companion-skill endpoint and preserves its creation result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          installedHosts: ['Claude Code'],
          skills: [{ name: 'okf-knowledge-base', created: true }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock;

    await expect(installPackSkill('okf')).resolves.toEqual({
      ok: true,
      installedHosts: ['Claude Code'],
      skills: [{ name: 'okf-knowledge-base', created: true }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/seed/install-pack-skill');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ packId: 'okf' });
  });
});
