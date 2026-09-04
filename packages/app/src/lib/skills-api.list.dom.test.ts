import { afterEach, describe, expect, test, vi } from 'vitest';
import { listSkills } from './skills-api';

const originalFetch = globalThis.fetch;

const respond = (body: unknown) =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

describe('listSkills', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('accepts a well-formed body despite the envelope flag getJson adds', async () => {
    globalThis.fetch = respond({
      skills: [
        {
          scope: 'project',
          name: 'grill-me',
          path: '.agents/skills/grill-me',
          installed: true,
          hosts: ['claude'],
        },
      ],
      truncated: false,
    });

    const res = await listSkills('project');

    expect(res).toEqual({
      ok: true,
      skills: [
        {
          scope: 'project',
          name: 'grill-me',
          path: '.agents/skills/grill-me',
          installed: true,
          hosts: ['claude'],
        },
      ],
    });
  });

  test('still rejects a body that actually drifted from the schema', async () => {
    globalThis.fetch = respond({ skills: [{ scope: 'project' }], truncated: false });

    expect(await listSkills('project')).toEqual({
      ok: false,
      error: 'The skills list did not match its schema.',
    });
  });

  test('scopes the request when asked, and omits the param otherwise', async () => {
    const fetchMock = respond({ skills: [], truncated: false });
    globalThis.fetch = fetchMock;

    await listSkills('global');
    await listSkills();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/skills?scope=global');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/skills');
  });
});
