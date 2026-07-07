/**
 * Unit tests for the single outbound dispatch entry point.
 *
 * Every target POSTs to `/api/handoff` with `{ target, url, workspacePath? }`.
 * No renderer-side timing dance — the server owns the recipe. Tests assert:
 *   (a) each target produces the right body shape
 *   (b) the URL passed in `body.url` is built by the matching URL builder
 *   (c) `workspacePath` is threaded only for Cursor (the cli-binary recipe)
 *   (d) HTTP failures map to `HandoffOutcome` shapes the toast hook expects
 *   (e) exhaustiveness guard fires for unknown targets at runtime
 */

import { describe, expect, mock, test } from 'bun:test';
import type { HandoffPayload, HandoffTarget } from '@inkeep/open-knowledge-core';
import { dispatchHandoff } from './dispatch.ts';

const BASE_PAYLOAD = {
  projectDir: '/Users/andrew/Documents/code/open-knowledge',
  docPath: '/Users/andrew/Documents/code/open-knowledge/specs/foo/SPEC.md',
  prompt: 'OpenKnowledge doc: specs/foo/SPEC.md.',
} as const;

function makeFetch(status: number, bodyJson?: unknown) {
  const fetchImpl = mock(async (..._args: Parameters<typeof globalThis.fetch>) => {
    return new Response(JSON.stringify(bodyJson ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return fetchImpl;
}

async function readSentBody(fetchImpl: typeof globalThis.fetch): Promise<unknown> {
  const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const [_url, init] = (calls[0] ?? []) as [string, RequestInit | undefined];
  if (!init?.body || typeof init.body !== 'string') {
    throw new Error('fetch was not called with a JSON body');
  }
  return JSON.parse(init.body);
}

describe('dispatchHandoff — claude-cowork', () => {
  test('POSTs /api/handoff with target=claude-cowork and a prompt-threaded claude://cowork/new URL', async () => {
    // Doc-scoped Claude handoff threads the directive prompt;
    // precedent #25 invariant preserved — no `file=` attach (the prompt is a
    // short directive, never the file body); the agent grounds via OK MCP.
    const fetchImpl = makeFetch(200);
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'claude-cowork' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result).toEqual({ ok: true });
    const body = (await readSentBody(fetchImpl)) as {
      target: string;
      url: string;
      workspacePath?: string;
    };
    expect(body.target).toBe('claude-cowork');
    expect(body.url).toMatch(/^claude:\/\/cowork\/new\?q=/);
    expect(body.url).toContain('folder=');
    expect(body.url).toContain('q=');
    // precedent #25 invariant: no native file-attach.
    expect(body.url).not.toContain('file=');
    expect(body.workspacePath).toBeUndefined();
  });
});

describe('dispatchHandoff — claude-code', () => {
  test('POSTs /api/handoff with target=claude-code and a prompt-threaded claude://code/new URL', async () => {
    const fetchImpl = makeFetch(200);
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'claude-code' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result).toEqual({ ok: true });
    const body = (await readSentBody(fetchImpl)) as { target: string; url: string };
    expect(body.target).toBe('claude-code');
    expect(body.url).toMatch(/^claude:\/\/code\/new\?q=/);
    expect(body.url).toContain('folder=');
    expect(body.url).toContain('q=');
    expect(body.url).not.toContain('file=');
    expect((body as { workspacePath?: string }).workspacePath).toBeUndefined();
  });
});

describe('dispatchHandoff — codex', () => {
  test('POSTs /api/handoff with target=codex and a prompt-threaded codex://new URL (no file=)', async () => {
    const fetchImpl = makeFetch(200);
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'codex' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result).toEqual({ ok: true });
    const body = (await readSentBody(fetchImpl)) as {
      target: string;
      url: string;
      workspacePath?: string;
    };
    expect(body.target).toBe('codex');
    expect(body.url).toMatch(/^codex:\/\/new\?prompt=/);
    expect(body.url).toContain('path=');
    expect(body.url).toContain('prompt=');
    // precedent #25 invariant: no native file-attach.
    expect(body.url).not.toContain('file=');
    // Codex doesn't need workspacePath — `path=` in the URL carries it for the
    // recipe; the workspacePath body field is cursor-only.
    expect(body.workspacePath).toBeUndefined();
  });
});

describe('dispatchHandoff — cursor', () => {
  test('POSTs /api/handoff with target=cursor, prompt-threaded cursor:// URL, and workspacePath', async () => {
    const fetchImpl = makeFetch(200);
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'cursor' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result).toEqual({ ok: true });
    const body = (await readSentBody(fetchImpl)) as {
      target: string;
      url: string;
      workspacePath: string;
    };
    expect(body.target).toBe('cursor');
    expect(body.url).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/);
    expect(body.url).toContain('text=');
    expect(body.url).toContain('workspace=');
    expect(body.url).toContain('mode=agent');
    // precedent #25 invariant: no native file-attach.
    expect(body.url).not.toContain('file=');
    expect(body.workspacePath).toBe(BASE_PAYLOAD.projectDir);
  });
});

describe('dispatchHandoff — HTTP failure mapping', () => {
  test('404 → not-installed (server missing /api/handoff route)', async () => {
    const fetchImpl = makeFetch(404);
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'codex' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-installed');
  });

  test('422 → not-installed (target binary/app missing on this machine)', async () => {
    const fetchImpl = makeFetch(422);
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'cursor' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-installed');
  });

  test('5xx → dispatch-error', async () => {
    const fetchImpl = makeFetch(500);
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'claude-code' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('dispatch-error');
  });

  test('network error (fetch throws) → dispatch-error with detail', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('NetworkError when attempting to fetch resource.');
    }) as unknown as typeof globalThis.fetch;
    const payload: HandoffPayload = { ...BASE_PAYLOAD, target: 'codex' };
    const result = await dispatchHandoff(payload, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('dispatch-error');
    expect(result.detail).toContain('NetworkError');
  });
});

describe('dispatchHandoff — runtime exhaustiveness guard', () => {
  test('unknown target (cast to HandoffTarget) produces invalid-payload at runtime', async () => {
    const payload = { ...BASE_PAYLOAD, target: 'zed' as HandoffTarget };
    const result = await dispatchHandoff(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-payload');
    expect(result.detail ?? '').toContain('zed');
  });
});
