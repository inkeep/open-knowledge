import { afterEach, describe, expect, test } from 'vitest';
import { HOCUSPOCUS_NOT_RUNNING_ERROR, UNREADABLE_WARNINGS_TEXT } from './shared.ts';
import { deleteSkill, moveSkill, moveSkillCrossScope, writeSkill } from './skill-target.ts';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
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

describe('moveSkill — a same-level rename collision surfaces the RFC 9457 detail', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('the retained-copy safety prose reaches the text channel, not just the title', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: 'urn:ok:error:conflict',
          title: 'A skill named "fishing-log" already exists.',
          status: 409,
          detail:
            'Do NOT delete it before reconciling it against the source: it may hold the only copy of files that failed removal already deleted.',
        }),
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      )) as typeof fetch;
    const r = (await moveSkill('http://127.0.0.1:9', {
      fromName: 'trip-log',
      toName: 'fishing-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('A skill named "fishing-log" already exists.');
    expect(text(r)).toContain(
      'it may hold the only copy of files that failed removal already deleted',
    );
    expect(r.structuredContent).toMatchObject({
      ok: false,
      kind: 'skill',
      error: 'A skill named "fishing-log" already exists.',
    });
  });
});

describe('moveSkillCrossScope — delegates to the canonical /api/skill/move-scope endpoint', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  interface Call {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }

  function mockFetch(handler: (call: Call) => Record<string, unknown>) {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string, init?: { method?: string; body?: string }) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        path: new URL(input).pathname,
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      };
      calls.push(call);
      const res = handler(call);
      if (res.ok === false) {
        return new Response(JSON.stringify({ ...res, error: res.error ?? 'error' }), {
          status: typeof res.status === 'number' ? res.status : 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return calls;
  }

  const move = (toName: string) =>
    moveSkillCrossScope('http://127.0.0.1:9', {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName,
    }) as Promise<ToolResult>;

  test.each(['unreadable', 'future-ledger-reason'])(
    'an inconsistent retained result cannot advertise an intact source: %s',
    async (retentionLedger) => {
      mockFetch(() => ({
        ok: false,
        status: 409,
        error: 'Move did not complete.',
        detail: 'The destination must be compared with the source.',
        moveState: 'destination-retained',
        sourceState: 'intact',
        retentionLedger,
        droppedLocations: ['agents'],
      }));
      const result = await move('trip-log');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('The destination must be compared with the source.');
      expect(text(result)).toContain('Do not remove either copy before comparing');
      expect(result.structuredContent).toMatchObject({ droppedLocations: ['agents'] });
      expect(result.structuredContent).not.toHaveProperty('sourceState');
      expect(result.structuredContent).not.toHaveProperty('moveState');
      expect(result.structuredContent).not.toHaveProperty('retentionLedger');
    },
  );

  test('a name-preserving move is one canonical request and reports editor re-projection', async () => {
    const calls = mockFetch(() => ({ ok: true, scope: 'global', path: '.agents/skills/trip-log' }));
    const r = await move('trip-log');
    expect(r.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/skill/move-scope',
        body: { name: 'trip-log', fromScope: 'project', toScope: 'global' },
      },
    ]);
    expect(text(r)).toContain('editor locations the Global level can host');
    expect(text(r)).not.toContain('install(');
    expect(text(r)).toContain('(Global)');
    expect(r.structuredContent).toMatchObject({
      ok: true,
      kind: 'skill',
      crossScope: true,
      committed: false,
      droppedLocations: [],
    });
  });

  test('a renaming move is still ONE request, carrying the destination name', async () => {
    const calls = mockFetch(() => ({ ok: true, scope: 'global' }));
    const r = await move('fishing-log');
    expect(r.isError).toBeUndefined();
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      [
        '/api/skill/move-scope',
        { name: 'trip-log', toName: 'fishing-log', fromScope: 'project', toScope: 'global' },
      ],
    ]);
    expect(text(r)).toContain('"fishing-log" (Global)');
    expect(r.structuredContent).toMatchObject({ ok: true, crossScope: true });
  });

  test('dropped locations are named with the install call that restores them', async () => {
    mockFetch(() => ({
      ok: true,
      scope: 'global',
      path: '.agents/skills/trip-log',
      droppedLocations: ['.team/skills', 'agents'],
    }));
    const r = await move('trip-log');
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('.team/skills, agents');
    expect(text(r)).toContain(
      'install({ name: "trip-log", scope: "global", add: [".team/skills", "agents"] })',
    );
    expect(r.structuredContent).toMatchObject({
      droppedLocations: ['.team/skills', 'agents'],
    });
  });

  test('the custom-root caveat names the destination base for the direction moved', async () => {
    const dropped = () => ({ ok: true, scope: 'global', droppedLocations: ['.team/skills'] });
    const crossScope = (fromScope: 'project' | 'global', toScope: 'project' | 'global') =>
      moveSkillCrossScope('http://127.0.0.1:9', {
        fromScope,
        toScope,
        fromName: 'trip-log',
        toName: 'trip-log',
      }) as Promise<ToolResult>;

    mockFetch(dropped);
    const toGlobal = await crossScope('project', 'global');
    expect(text(toGlobal)).toContain('destination base — your home directory —');
    expect(text(toGlobal)).not.toContain('the project directory');

    mockFetch(dropped);
    const toProject = await crossScope('global', 'project');
    expect(text(toProject)).toContain('destination base — the project directory —');
    expect(text(toProject)).not.toContain('your home directory');
  });

  test('a failure that destroyed the source ledger still carries the dropped locations', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      error: 'The source was removed, but the destination skill is unreadable.',
      moveState: 'destination-unreadable',
      droppedLocations: ['.team/skills', 'agents'],
    }));
    const r = await move('trip-log');
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      ok: false,
      moveState: 'destination-unreadable',
      droppedLocations: ['.team/skills', 'agents'],
    });
  });

  test('a retained destination from an earlier failure is not reported as safe to retry', async () => {
    mockFetch(() => ({
      ok: false,
      status: 409,
      error: 'A global skill named "trip-log" already exists.',
      moveState: 'destination-retained-blocking',
      sourceState: 'intact',
    }));
    const r = await move('trip-log');
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      moveState: 'destination-retained-blocking',
      sourceState: 'intact',
    });
  });

  test('a retained destination with no source state is withheld rather than half-reported', async () => {
    mockFetch(() => ({
      ok: false,
      status: 409,
      error: 'A global skill named "trip-log" already exists.',
      moveState: 'destination-retained-blocking',
    }));
    const r = await move('trip-log');
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Do not remove either copy before comparing');
    expect(r.structuredContent).not.toHaveProperty('moveState');
    expect(r.structuredContent).not.toHaveProperty('sourceState');
    expect(r.structuredContent).not.toHaveProperty('retentionLedger');
  });

  test('a refusal before the request is made reports that nothing was written', async () => {
    const calls = mockFetch(() => ({ ok: true, scope: 'global' }));
    const r = (await moveSkillCrossScope(undefined, {
      fromScope: 'project',
      toScope: 'global',
      fromName: 'trip-log',
      toName: 'trip-log',
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(r.structuredContent).toMatchObject({
      ok: false,
      kind: 'skill',
      moveState: 'nothing-written',
    });
  });

  test('an endpoint refusal surfaces its message and attempts nothing else', async () => {
    const calls = mockFetch(() => ({
      ok: false,
      status: 409,
      error: 'A global skill named "trip-log" already exists.',
      moveState: 'nothing-written',
    }));
    const r = await move('fishing-log');
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already exists');
    expect(calls).toHaveLength(1);
    expect(r.structuredContent).toMatchObject({
      ok: false,
      kind: 'skill',
      moveState: 'nothing-written',
    });
  });

  test.each(['unreadable', 'occupant-unverifiable'] as const)(
    'a %s retention ledger survives the adapter, so the caller can see the occupant is unverified',
    async (retentionLedger) => {
      mockFetch(() => ({
        ok: false,
        status: 409,
        error: 'A global skill named "trip-log" already exists.',
        moveState: 'nothing-written',
        retentionLedger,
      }));
      const r = await move('trip-log');
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        moveState: 'nothing-written',
        retentionLedger,
      });
    },
  );

  test('a retentionLedger outside the advertised enum is dropped rather than forwarded', async () => {
    mockFetch(() => ({
      ok: false,
      status: 409,
      error: 'A global skill named "trip-log" already exists.',
      moveState: 'nothing-written',
      retentionLedger: 'some-future-ledger-state',
    }));
    const r = await move('trip-log');
    expect(r.isError).toBe(true);
    expect(r.structuredContent).not.toHaveProperty('retentionLedger');
  });

  test('a moveState outside the advertised enum is dropped rather than forwarded', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      error: 'Failed to move skill across scopes.',
      moveState: 'some-future-state',
    }));
    const r = await move('fishing-log');
    expect(r.isError).toBe(true);
    expect(r.structuredContent).not.toHaveProperty('moveState');
  });

  test('endpoint details stay in the text channel while the structured error stays the title', async () => {
    const error = 'Cannot move to project scope.';
    mockFetch(() => ({ ok: false, status: 400, error, detail: 'NO_PROJECT_ROOT' }));
    const result = await move('fishing-log');
    expect(text(result)).toBe(`Error: ${error} (NO_PROJECT_ROOT)`);
    expect(result.structuredContent).toMatchObject({ ok: false, error });
  });
});

describe('writeSkill — an unreadable warnings payload reaches BOTH channels', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a non-array `warnings` is rendered in the text, not only in the structured field', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          created: true,
          path: '.agents/skills/trip-log/SKILL.md',
          warnings: 'Skill name contains "claude".',
          warningCodes: ['skill-name-vendor-word'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const r = (await writeSkill('http://127.0.0.1:9', {
      name: 'trip-log',
      description: 'Use when logging a trip.',
    })) as ToolResult;

    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('treat this result as unverified');
    expect((r.structuredContent?.skill as { warnings?: unknown })?.warnings).toEqual([
      UNREADABLE_WARNINGS_TEXT,
    ]);
  });
});
