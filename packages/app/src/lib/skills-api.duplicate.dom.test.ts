import { afterEach, describe, expect, test, vi } from 'vitest';
import { duplicateSkill } from './skills-api';

const originalFetch = globalThis.fetch;

describe('duplicateSkill', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('requests a server-side complete bundle copy under the next available name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: 'example-copy-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock;

    const result = await duplicateSkill({
      scope: 'global',
      name: 'example',
      existingNames: new Set(['example', 'example-copy']),
    });

    expect(result).toEqual({ ok: true, name: 'example-copy-2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/skill/duplicate');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      scope: 'global',
      name: 'example',
      toName: 'example-copy-2',
    });
  });
});
