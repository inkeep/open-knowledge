/**
 * Contract tests for the skill verb-tool HTTP helpers (`write` / `delete` /
 * `move` over the `skill` target). Two server-independent guarantees the verb
 * tools rely on, exercised without spinning a server:
 *
 *   1. Server-required: with no Hocuspocus URL, each helper returns the
 *      standard not-running tool error (never a thrown exception or a silent
 *      no-op).
 *   2. Name grammar: an invalid skill name is rejected with the teaching error
 *      BEFORE any network call (so it short-circuits even when a URL is given).
 *
 * No git/server fixtures here, so unlike the heavier MCP roundtrip suites this
 * runs in CI too.
 */

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
  // A defined URL proves the name check fires first: a real fetch to this
  // address would hang/refuse, so reaching the teaching error means no request
  // was made.
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

  /**
   * Record the (method, path) of each call; reply per a scripted handler. A
   * handler result of `{ ok: false, error }` is mapped to an HTTP error with a
   * problem+json `{ error }` body — the http helpers key success off the wire
   * status (`res.ok`), not a body `ok` field, so a 200 with `ok:false` would be
   * read as success. The status defaults to 500 (transient); pass an explicit
   * `status` (e.g. 404 for a genuinely-absent skill) when the wire status is
   * load-bearing — the cross-scope collision guard only treats a clean 404 as
   * "destination free", so an absent destination MUST be modeled as 404, not 500.
   */
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

  // GET handler shared by the happy-path tests: the SOURCE scope's skill exists,
  // the DESTINATION scope's does NOT (so the collision guard passes). `scope=` in
  // the query string disambiguates the two reads (source fetch + dest-guard fetch).
  const getSourceExistsDestAbsent =
    (destScope: 'global' | 'project') => (method: string, path: string) => {
      if (method === 'GET') {
        // A genuinely-absent destination is a 404 — the collision guard only
        // reads a clean 404 as "free" (a 500/timeout aborts the move).
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
    // Two GETs (source read + dest collision-guard), then PUT, then DELETE.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PUT', 'DELETE']);
    // Destination is written before the source is removed (never lose the skill).
    expect(calls.findIndex((c) => c.method === 'PUT')).toBeLessThan(
      calls.findIndex((c) => c.method === 'DELETE'),
    );
    expect(text(r)).toContain('install');
    expect(text(r)).toContain('Global');
  });

  test('refuses to overwrite an existing destination-scope skill (collision guard)', async () => {
    // BOTH scopes have the skill → the guard must abort before any PUT/DELETE,
    // mirroring the editor's moveSkillScope. Without it, PUT's upsert would
    // silently destroy the destination skill's content.
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
    // No destructive calls: the move aborted at the guard.
    expect(calls.some((c) => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });

  test('aborts before any write when the destination scope read fails transiently', async () => {
    // The dest collision-guard GET returns 500 (not 404). A transient failure is
    // NOT proof the destination is free — proceeding would upsert over a skill
    // that might exist, then delete the source (data loss). The guard must abort.
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
    // No destructive calls: the move aborted at the guard before PUT/DELETE.
    expect(calls.some((c) => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });

  test('skips a binary bundle file (415) with a warning instead of aborting', async () => {
    // The source has one reference file; reading it returns 415 (binary, outside
    // the text-only bundle contract). The move should SKIP it (not abort) and
    // surface it — matching the editor's moveSkillScope.
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
    // The source was still deleted — the move completed (binary skip is not fatal).
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
    // Source delete must NOT have fired — the skill is preserved in its origin.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
