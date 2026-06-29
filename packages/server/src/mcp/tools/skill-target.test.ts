
import { afterEach, describe, expect, test } from 'bun:test';
import { HOCUSPOCUS_NOT_RUNNING_ERROR } from './shared.ts';
import { deleteSkill, moveSkill, moveSkillCrossScope, writeSkill } from './skill-target.ts';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const text = (r: ToolResult) => r.content[0]?.text ?? '';

describe('skill verb tools — server-required contract', () => {
  test('writeSkill with no server URL returns the not-running error', async () => {
    const r = (await writeSkill(undefined, {
      name: 'trip-log',
      description: 'Use when logging a trip.',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });

  test('deleteSkill with no server URL returns the not-running error', async () => {
    const r = (await deleteSkill(undefined, { name: 'trip-log' })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });

  test('moveSkill with no server URL returns the not-running error', async () => {
    const r = (await moveSkill(undefined, {
      fromName: 'trip-log',
      toName: 'fishing-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('skill verb tools — name grammar short-circuits before the network', () => {
  const UNREACHABLE = 'http://127.0.0.1:1';

  test('writeSkill rejects an invalid name with the teaching error', async () => {
    const r = (await writeSkill(UNREACHABLE, {
      name: 'Bad Name!',
      description: 'd',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('lowercase letters');
  });

  test('moveSkill rejects an invalid fromName with the teaching error', async () => {
    const r = (await moveSkill(UNREACHABLE, {
      fromName: 'Bad From!',
      toName: 'fishing-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('lowercase letters');
  });

  test('moveSkillCrossScope with no server URL returns the not-running error', async () => {
    const r = (await moveSkillCrossScope(undefined, {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });

  test('moveSkillCrossScope rejects an invalid name before the network', async () => {
    const r = (await moveSkillCrossScope(UNREACHABLE, {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'Bad Name!',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('lowercase letters');
  });
});

describe('moveSkillCrossScope — write-dest-then-delete-source compose', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(handler: (method: string, path: string) => Record<string, unknown>) {
    const calls: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      const url = new URL(input);
      const path = url.pathname + url.search;
      calls.push({ method, path });
      const body = handler(method, path);
      if (body.ok === false) {
        return new Response(JSON.stringify({ error: body.error ?? 'error' }), {
          status: typeof body.status === 'number' ? body.status : 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return calls;
  }

  const getSourceExistsDestAbsent =
    (destScope: 'global' | 'project') => (method: string, path: string) => {
      if (method === 'GET') {
        if (path.includes(`scope=${destScope}`))
          return { ok: false, status: 404, error: 'not found' };
        return { ok: true, skill: { frontmatter: { description: 'd' }, body: '## When\n\nx.' } };
      }
      return { ok: false, error: 'unexpected' };
    };

  test('reads source, writes destination, THEN deletes source — and prompts re-install', async () => {
    const base = getSourceExistsDestAbsent('global');
    const calls = mockFetch((method, path) => {
      if (method === 'PUT') return { ok: true, created: true, path: 'trip-log/SKILL.md' };
      if (method === 'DELETE') return { ok: true, existed: true };
      return base(method, path);
    });
    const r = (await moveSkillCrossScope('http://127.0.0.1:9', {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PUT', 'DELETE']);
    expect(calls.findIndex((c) => c.method === 'PUT')).toBeLessThan(
      calls.findIndex((c) => c.method === 'DELETE'),
    );
    expect(text(r)).toContain('install');
    expect(text(r)).toContain('Global');
  });

  test('refuses to overwrite an existing destination-scope skill (collision guard)', async () => {
    const calls = mockFetch((method) => {
      if (method === 'GET')
        return { ok: true, skill: { frontmatter: { description: 'd' }, body: 'x' } };
      return { ok: false, error: 'unexpected' };
    });
    const r = (await moveSkillCrossScope('http://127.0.0.1:9', {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already exists');
    expect(calls.some((c) => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });

  test('aborts before any write when the destination scope read fails transiently', async () => {
    const calls = mockFetch((method, path) => {
      if (method === 'GET') {
        if (path.includes('scope=global')) return { ok: false, status: 500, error: 'db down' };
        return { ok: true, skill: { frontmatter: { description: 'd' }, body: 'x' } };
      }
      return { ok: false, error: 'unexpected' };
    });
    const r = (await moveSkillCrossScope('http://127.0.0.1:9', {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('could not verify');
    expect(calls.some((c) => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });

  test('skips a binary bundle file (415) with a warning instead of aborting', async () => {
    const calls = mockFetch((method, path) => {
      if (method === 'GET') {
        if (path.includes('/api/skill-file'))
          return { ok: false, status: 415, error: 'unsupported media type' };
        if (path.includes('scope=global')) return { ok: false, status: 404, error: 'not found' };
        return {
          ok: true,
          skill: {
            frontmatter: { description: 'd' },
            body: '## When\n\nx.',
            files: [{ path: 'references/diagram.png' }],
          },
        };
      }
      if (method === 'PUT') return { ok: true, created: true, path: 'trip-log/SKILL.md' };
      if (method === 'DELETE') return { ok: true, existed: true };
      return { ok: false, error: 'unexpected' };
    });
    const r = (await moveSkillCrossScope('http://127.0.0.1:9', {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('binary');
    expect(text(r)).toContain('references/diagram.png');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  test('a failed source delete reports the skill now lives in BOTH levels', async () => {
    const base = getSourceExistsDestAbsent('global');
    mockFetch((method, path) => {
      if (method === 'PUT') return { ok: true, created: true };
      if (method === 'DELETE') return { ok: false, error: 'locked' };
      return base(method, path);
    });
    const r = (await moveSkillCrossScope('http://127.0.0.1:9', {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('BOTH');
  });

  test('a failed destination write aborts WITHOUT deleting the source', async () => {
    const base = getSourceExistsDestAbsent('project');
    const calls = mockFetch((method, path) => {
      if (method === 'PUT') return { ok: false, error: 'disk full' };
      return base(method, path);
    });
    const r = (await moveSkillCrossScope('http://127.0.0.1:9', {
      fromScope: 'global',
      toScope: 'project',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
