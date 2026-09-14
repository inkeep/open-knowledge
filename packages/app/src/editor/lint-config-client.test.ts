import { DEFAULT_LINTER_CONFIG } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyFrontmatterSchema,
  deleteFrontmatterSchema,
  fixLintDoc,
  LINT_FIX_TIMEOUT_MS,
  removeFrontmatterSchemaField,
  renameFrontmatterSchemaField,
  subscribeToLintConfigChanged,
  writeFrontmatterSchemaField,
  writeMarkdownlintRule,
} from './lint-config-client.ts';

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn;

function stubFetch(fn: FetchFn): void {
  globalThis.fetch = fn;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

const CONFIG_RESPONSE = {
  effective: DEFAULT_LINTER_CONFIG,
  configFile: null,
  configProblems: [],
};

describe('writeMarkdownlintRule', () => {
  it('posts the rule update and returns the schema-parsed configuration', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    stubFetch(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(CONFIG_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const outcome = await writeMarkdownlintRule('MD012', { maximum: 3 });

    expect(outcome).toEqual({ ok: true, response: CONFIG_RESPONSE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/lint/markdownlint-config');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleId: 'MD012', value: { maximum: 3 } }),
    });
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    ['a schema-invalid body', new Response(JSON.stringify({ unexpected: true }), { status: 200 })],
  ])('rejects a successful response with %s', async (_label, response) => {
    stubFetch(async () => response.clone());
    await expect(writeMarkdownlintRule('MD012', false)).resolves.toEqual({
      ok: false,
      errorDetail: null,
    });
  });

  it('preserves a problem title from a rejected write', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ title: 'Config cannot be rewritten.' }), { status: 409 }),
    );
    await expect(writeMarkdownlintRule('MD012', false)).resolves.toEqual({
      ok: false,
      errorDetail: 'Config cannot be rewritten.',
    });
  });

  it('returns a title-less failure when the request does not reach the server', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(writeMarkdownlintRule('MD012', false)).resolves.toEqual({
      ok: false,
      errorDetail: null,
    });
  });
});

describe('frontmatter schema writes', () => {
  it('serializes every operation and emits the local event only for successful create and delete', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    stubFetch(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(CONFIG_RESPONSE), { status: 200 });
    });
    vi.stubGlobal('window', new EventTarget());
    let eventCount = 0;
    const unsubscribe = subscribeToLintConfigChanged(() => {
      eventCount += 1;
    });
    try {
      await expect(createEmptyFrontmatterSchema('.ok/schemas/doc.schema.json')).resolves.toEqual({
        ok: true,
        response: CONFIG_RESPONSE,
      });
      await expect(
        writeFrontmatterSchemaField(
          '.ok/schemas/doc.schema.json',
          'name',
          { type: 'string', required: true },
          ['items', { items: true }],
        ),
      ).resolves.toEqual({ ok: true, response: CONFIG_RESPONSE });
      await expect(
        removeFrontmatterSchemaField('.ok/schemas/doc.schema.json', 'name', ['items']),
      ).resolves.toEqual({ ok: true, response: CONFIG_RESPONSE });
      await expect(
        renameFrontmatterSchemaField('.ok/schemas/doc.schema.json', 'name', 'title'),
      ).resolves.toEqual({ ok: true, response: CONFIG_RESPONSE });
      await expect(deleteFrontmatterSchema('.ok/schemas/doc.schema.json')).resolves.toEqual({
        ok: true,
        response: CONFIG_RESPONSE,
      });

      expect(eventCount).toBe(2);
      expect(calls.map((call) => call.input)).toEqual(
        Array.from({ length: 5 }, () => '/api/lint/frontmatter-schema'),
      );
      expect(calls.map((call) => call.init?.method)).toEqual(
        Array.from({ length: 5 }, () => 'POST'),
      );
      expect(calls.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
        { file: '.ok/schemas/doc.schema.json' },
        {
          file: '.ok/schemas/doc.schema.json',
          field: 'name',
          constraint: { type: 'string', required: true },
          parentPath: ['items', { items: true }],
        },
        {
          file: '.ok/schemas/doc.schema.json',
          field: 'name',
          removeField: true,
          parentPath: ['items'],
        },
        { file: '.ok/schemas/doc.schema.json', field: 'name', renameTo: 'title' },
        { file: '.ok/schemas/doc.schema.json', delete: true },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit a local event when create or delete fails', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ title: 'Schema cannot be rewritten.' }), { status: 409 }),
    );
    vi.stubGlobal('window', new EventTarget());
    let eventCount = 0;
    const unsubscribe = subscribeToLintConfigChanged(() => {
      eventCount += 1;
    });
    try {
      await expect(createEmptyFrontmatterSchema('.ok/schemas/doc.schema.json')).resolves.toEqual({
        ok: false,
        errorDetail: 'Schema cannot be rewritten.',
      });
      await expect(deleteFrontmatterSchema('.ok/schemas/doc.schema.json')).resolves.toEqual({
        ok: false,
        errorDetail: 'Schema cannot be rewritten.',
      });
      expect(eventCount).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    ['a schema-invalid body', new Response(JSON.stringify({ unexpected: true }), { status: 200 })],
  ])('rejects a successful response with %s', async (_label, response) => {
    stubFetch(async () => response.clone());
    await expect(createEmptyFrontmatterSchema('.ok/schemas/doc.schema.json')).resolves.toEqual({
      ok: false,
      errorDetail: null,
    });
  });

  it('returns a title-less failure when the request does not reach the server', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(createEmptyFrontmatterSchema('.ok/schemas/doc.schema.json')).resolves.toEqual({
      ok: false,
      errorDetail: null,
    });
  });
});

describe('fixLintDoc', () => {
  it('surfaces the 503 status and capacity URN so the sweep can retry backpressure', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:too-many-agent-sessions',
            title: 'Too many agent sessions.',
            status: 503,
          }),
          { status: 503, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: 'Too many agent sessions.',
      status: 503,
      problemType: 'urn:ok:error:too-many-agent-sessions',
    });
  });

  it('preserves the server error title and surfaces status and URN for a non-capacity failure', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:disk-divergence',
            title: 'Document changed on disk.',
            status: 409,
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: 'Document changed on disk.',
      status: 409,
      problemType: 'urn:ok:error:disk-divergence',
    });
  });

  it('surfaces the HTTP status even when the error body is unparseable', async () => {
    stubFetch(async () => new Response('<html>oops', { status: 500 }));
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: null,
      status: 500,
      problemType: null,
    });
  });

  it('reports a failure with no URN when a 2xx body fails schema validation', async () => {
    stubFetch(async () => new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }));
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: null,
      status: 200,
      problemType: null,
    });
  });

  it('reports a failure with no status when the request never reaches the server', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: false,
      errorDetail: null,
      status: null,
      problemType: null,
    });
  });

  it('resolves a stalled request to a terminal failure after the fix timeout', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );
      const outcome = fixLintDoc('doc-a');
      await vi.advanceTimersByTimeAsync(LINT_FIX_TIMEOUT_MS);
      await expect(outcome).resolves.toEqual({
        ok: false,
        errorDetail: null,
        status: null,
        problemType: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the parsed result on success', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            file: 'doc-a',
            fixedCount: 2,
            diagnostics: [],
            errorCount: 0,
            warningCount: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const outcome = await fixLintDoc('doc-a');
    expect(outcome).toEqual({
      ok: true,
      result: { file: 'doc-a', fixedCount: 2, diagnostics: [], errorCount: 0, warningCount: 0 },
    });
  });

  it('preserves degraded success fields, nested fixes, and request serialization', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const result = {
      file: 'doc-a.md',
      fixedCount: 0,
      diagnostics: [
        {
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 1 },
          },
          severity: 'warning',
          source: 'markdownlint',
          code: 'MD010',
          message: 'Hard tabs',
          fixes: [
            {
              range: {
                start: { line: 2, character: 0 },
                end: { line: 2, character: 1 },
              },
              newText: ' ',
            },
          ],
        },
      ],
      errorCount: 0,
      warningCount: 1,
      ran: ['markdownlint', 'frontmatter'],
      warnings: ['frontmatter config warning'],
      diagnosticsArePreFix: true,
      reLintFailure: {
        reason: 'source-went-blind',
        message: 'markdownlint became unavailable',
      },
    };
    stubFetch(async (input, init) => {
      calls.push({ input, init });
      return Response.json(result);
    });

    const outcome = await fixLintDoc('doc-a');

    expect(outcome).toEqual({ ok: true, result });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/lint/fix');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docName: 'doc-a' }),
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
