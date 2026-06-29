import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { type Config, ConfigSchema } from '../../config/schema.ts';
import {
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGet,
  httpPost,
  normalizeDocName,
  okReservedPathRedirect,
  outputSchemaWithText,
  parseRenameCollidingPairs,
  resolveProjectConfigContext,
  resolveProjectServerContext,
  TEXT_CHANNEL_FIELD,
  textPlusStructured,
  textResult,
} from './shared.ts';

const TEST_CONFIG: Config = ConfigSchema.parse({ content: { dir: 'content' } });

describe('textResult', () => {
  test('wraps text in MCP content array', () => {
    const result = textResult('hello');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  test('includes isError flag when true', () => {
    const result = textResult('fail', true);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'fail' }],
      isError: true,
    });
  });

  test('omits isError when false or undefined', () => {
    const result = textResult('ok', false);
    expect(result).not.toHaveProperty('isError');
    const result2 = textResult('ok');
    expect(result2).not.toHaveProperty('isError');
  });
});

describe('textPlusStructured', () => {
  test('wraps body in MCP content array AND mirrors it under structuredContent.text', () => {
    const result = textPlusStructured('hello', { previewUrl: null });
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.structuredContent).toEqual({ text: 'hello', previewUrl: null });
  });

  test('does not surface body under an underscore-prefixed key (PRD-6663 regression guard)', () => {
    const result = textPlusStructured('hello-body', { previewUrl: null });
    const keys = Object.keys(result.structuredContent ?? {});
    expect(keys.filter((k) => k.startsWith('_'))).toEqual([]);
  });

  test('preserves caller structured fields alongside the auto-mirror', () => {
    const result = textPlusStructured('body', {
      previewUrl: 'http://localhost:5173/p/x',
      stdout: 'raw',
      cwd: '/tmp',
    });
    expect(result.structuredContent).toEqual({
      text: 'body',
      previewUrl: 'http://localhost:5173/p/x',
      stdout: 'raw',
      cwd: '/tmp',
    });
  });

  test('caller-provided `text` field overrides the auto-duplicated body', () => {
    const result = textPlusStructured('visible', { text: 'structured-different' });
    expect(result.content).toEqual([{ type: 'text', text: 'visible' }]);
    expect(result.structuredContent).toEqual({ text: 'structured-different' });
  });

  test('isError flag propagates to top level', () => {
    const result = textPlusStructured('failed', { error: 'boom' }, true);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'failed' }],
      structuredContent: { text: 'failed', error: 'boom' },
      isError: true,
    });
  });

  test('omits isError when false or undefined', () => {
    const a = textPlusStructured('ok', { x: 1 }, false);
    expect(a).not.toHaveProperty('isError');
    const b = textPlusStructured('ok', { x: 1 });
    expect(b).not.toHaveProperty('isError');
  });

  test('empty structured object: still emits structuredContent.text', () => {
    const result = textPlusStructured('done', {});
    expect(result.structuredContent).toEqual({ text: 'done' });
  });
});

describe('outputSchemaWithText — PRD-6655 / PRD-6656 schema-level mirror declaration', () => {
  test('declares `text` alongside the caller-supplied fields without mutating them', () => {
    const base = {
      result: z.string(),
      count: z.number(),
    };
    const augmented = outputSchemaWithText(base);
    expect(Object.keys(augmented).sort()).toEqual(['count', 'result', 'text']);
    expect(augmented.result).toBe(base.result);
    expect(augmented.count).toBe(base.count);
    expect(augmented.text).toBe(TEXT_CHANNEL_FIELD);
  });

  test('empty shape: `text` is the only field', () => {
    const augmented = outputSchemaWithText({});
    expect(Object.keys(augmented)).toEqual(['text']);
    expect(augmented.text).toBe(TEXT_CHANNEL_FIELD);
  });

  test('caller-supplied `text` overrides the default schema declaration', () => {
    const custom = z.literal('custom').describe('caller-specific');
    const augmented = outputSchemaWithText({ text: custom });
    expect(augmented.text).toBe(custom);
    expect(augmented.text).not.toBe(TEXT_CHANNEL_FIELD);
  });

  test('`text` is a Zod optional string', () => {
    const parsed = TEXT_CHANNEL_FIELD.safeParse('hello');
    expect(parsed.success).toBe(true);
    const undef = TEXT_CHANNEL_FIELD.safeParse(undefined);
    expect(undef.success).toBe(true);
    const num = TEXT_CHANNEL_FIELD.safeParse(42);
    expect(num.success).toBe(false);
  });
});

describe('normalizeDocName', () => {
  test('strips trailing .md silently', () => {
    const result = normalizeDocName('notes/meeting.md');
    expect(result).toEqual({ ok: true, docName: 'notes/meeting' });
  });

  test('strips trailing .mdx silently', () => {
    const result = normalizeDocName('notes/meeting.mdx');
    expect(result).toEqual({ ok: true, docName: 'notes/meeting' });
  });

  test('strips uppercase .MD (case-insensitive)', () => {
    const result = normalizeDocName('NOTES.MD');
    expect(result).toEqual({ ok: true, docName: 'NOTES' });
  });

  test('strips mixed-case .Mdx (case-insensitive)', () => {
    const result = normalizeDocName('Component.Mdx');
    expect(result).toEqual({ ok: true, docName: 'Component' });
  });

  test('strips every trailing supported extension (PRD-6837 #2)', () => {
    expect(normalizeDocName('notes/meeting.md.md')).toEqual({
      ok: true,
      docName: 'notes/meeting',
    });
    expect(normalizeDocName('notes/meeting.mdx.md')).toEqual({
      ok: true,
      docName: 'notes/meeting',
    });
    expect(normalizeDocName('a.md.md.md')).toEqual({ ok: true, docName: 'a' });
  });

  test('leaves extension-less docName untouched', () => {
    const result = normalizeDocName('notes/meeting');
    expect(result).toEqual({ ok: true, docName: 'notes/meeting' });
  });

  test('rejects .markdown — unsupported extension', () => {
    const result = normalizeDocName('notes/meeting.markdown');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('.markdown');
      expect(result.error).toContain('not a supported extension');
    }
  });

  test('leaves unrelated dotted names untouched', () => {
    const result = normalizeDocName('releases/v1.0');
    expect(result).toEqual({ ok: true, docName: 'releases/v1.0' });
  });

  test('handles root-level docName with .md', () => {
    const result = normalizeDocName('PROJECT.md');
    expect(result).toEqual({ ok: true, docName: 'PROJECT' });
  });

  for (const raw of ['   ', '.', '..', 'a/', '.foo', 'x\ty', ' leading', 'trailing ']) {
    test(`rejects malformed docName ${JSON.stringify(raw)}`, () => {
      const result = normalizeDocName(raw);
      expect(result.ok).toBe(false);
    });
  }

  test('rejects a docName that is only an extension', () => {
    expect(normalizeDocName('.md').ok).toBe(false);
  });
});

describe('HOCUSPOCUS_NOT_RUNNING_ERROR', () => {
  test('contains actionable guidance', () => {
    expect(HOCUSPOCUS_NOT_RUNNING_ERROR).toContain('ok start');
    expect(HOCUSPOCUS_NOT_RUNNING_ERROR).toContain('native Edit tool');
  });
});

describe('resolveProjectConfigContext', () => {
  test('returns cwd and resolved config on success', async () => {
    const result = await resolveProjectConfigContext(
      async () => '/workspace/project',
      async (cwd) => ({
        ...TEST_CONFIG,
        content: { ...TEST_CONFIG.content, dir: cwd ?? 'content' },
      }),
    );

    expect(result).toEqual({
      ok: true,
      cwd: '/workspace/project',
      executionCwd: '/workspace/project',
      config: {
        ...TEST_CONFIG,
        content: { ...TEST_CONFIG.content, dir: '/workspace/project' },
      },
    });
  });

  test('executionCwd is the literal explicit cwd; cwd is the walked-up root', async () => {
    const result = await resolveProjectConfigContext(
      async () => '/workspace/project',
      TEST_CONFIG,
      '/workspace/project/subdir/nested',
    );

    expect(result).toEqual({
      ok: true,
      cwd: '/workspace/project',
      executionCwd: '/workspace/project/subdir/nested',
      config: TEST_CONFIG,
    });
  });

  test('returns an error when resolveCwd throws', async () => {
    const result = await resolveProjectConfigContext(async () => {
      throw new Error('No client roots');
    }, TEST_CONFIG);

    expect(result).toEqual({ ok: false, error: 'No client roots' });
  });

  test('returns an error when config resolution throws', async () => {
    const result = await resolveProjectConfigContext(
      async () => '/workspace/project',
      async () => {
        throw new Error('Config exploded');
      },
    );

    expect(result).toEqual({ ok: false, error: 'Config exploded' });
  });
});

describe('resolveProjectServerContext', () => {
  test('returns cwd, config, and server url on success', async () => {
    const result = await resolveProjectServerContext(
      async () => '/workspace/project',
      TEST_CONFIG,
      async (cwd) => `ws://localhost/${cwd?.split('/').at(-1)}`,
    );

    expect(result).toEqual({
      ok: true,
      cwd: '/workspace/project',
      executionCwd: '/workspace/project',
      config: TEST_CONFIG,
      url: 'ws://localhost/project',
    });
  });

  test('propagates config-context failure', async () => {
    const result = await resolveProjectServerContext(
      async () => {
        throw new Error('Explicit cwd required');
      },
      TEST_CONFIG,
      async () => 'ws://localhost/project',
    );

    expect(result).toEqual({ ok: false, error: 'Explicit cwd required' });
  });

  test('returns an error when server resolution throws', async () => {
    const result = await resolveProjectServerContext(
      async () => '/workspace/project',
      TEST_CONFIG,
      async () => {
        throw new Error('Server lookup failed');
      },
    );

    expect(result).toEqual({ ok: false, error: 'Server lookup failed' });
  });
});

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  testServer = Bun.serve({
    port: 0, // random available port
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/flat-success') {
        return Response.json({ data: 'hello' });
      }
      if (url.pathname === '/not-json') {
        return new Response('plain text', { status: 200 });
      }
      if (url.pathname === '/not-json-5xx') {
        return new Response('upstream blew up', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      if (url.pathname === '/post-echo') {
        return req.json().then((body) => Response.json({ received: body }));
      }
      if (url.pathname === '/slow') {
        return new Promise((resolve) =>
          setTimeout(() => resolve(Response.json({ data: 'late' })), 100),
        );
      }
      if (url.pathname === '/rfc9457-not-found') {
        return Response.json(
          {
            type: 'urn:ok:error:doc-not-found',
            title: 'Not found.',
            status: 404,
            instance: 'urn:uuid:11111111-1111-1111-1111-111111111111',
          },
          { status: 404 },
        );
      }
      if (url.pathname === '/rfc9457-with-extensions') {
        return Response.json(
          {
            type: 'urn:ok:error:doc-already-exists',
            title: 'Exists.',
            status: 409,
            instance: 'urn:uuid:22222222-2222-2222-2222-222222222222',
            colliding: [{ existing: 'a', incoming: 'b', to: 'c' }],
          },
          { status: 409 },
        );
      }
      if (url.pathname === '/rfc9457-with-detail') {
        return Response.json(
          {
            type: 'urn:ok:error:internal-server-error',
            title: 'Internal server error.',
            status: 500,
            instance: 'urn:uuid:33333333-3333-3333-3333-333333333333',
            detail: 'Database connection pool exhausted; retry after 5s.',
          },
          { status: 500 },
        );
      }
      if (url.pathname === '/d22-flat-success') {
        return Response.json({ src: 'photo.png', deduped: true });
      }
      if (url.pathname === '/d22-success-with-type-title') {
        return Response.json({ type: 'document', title: 'My Page', body: 'hello' });
      }
      if (url.pathname === '/array-body-2xx') {
        return Response.json(['a', 'b', 'c']);
      }
      if (url.pathname === '/array-body-5xx') {
        return Response.json(['a', 'b', 'c'], { status: 500 });
      }
      if (url.pathname === '/null-body-2xx') {
        return Response.json(null);
      }
      if (url.pathname === '/non-rfc9457-5xx') {
        return Response.json({ message: 'upstream blew up', code: 'EX_BACKEND' }, { status: 502 });
      }
      if (url.pathname === '/intermediary-stray-ok-2xx') {
        return Response.json({ ok: false, data: 'succeeded' });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});

afterAll(() => {
  testServer.stop();
});

describe('httpGet', () => {
  test('flat 2xx success body: synthesizes ok=true and preserves payload fields', async () => {
    const result = await httpGet(baseUrl, '/flat-success');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('hello');
  });

  test('non-JSON 2xx response: ok:false with contract-violation error', async () => {
    const result = await httpGet(baseUrl, '/not-json');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2xx response with non-JSON body');
  });

  test('non-JSON ≥400 response: ok:false with HTTP-status error', async () => {
    const result = await httpGet(baseUrl, '/not-json-5xx');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });

  test('handles unreachable server', async () => {
    const result = await httpGet('http://localhost:1', '/anything');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Server unreachable');
  });
});

describe('httpPost', () => {
  test('sends JSON body and returns parsed response', async () => {
    const result = await httpPost(baseUrl, '/post-echo', { key: 'value' });
    expect(result.ok).toBe(true);
    expect(result.received).toEqual({ key: 'value' });
  });

  test('works without body', async () => {
    const result = await httpPost(baseUrl, '/flat-success');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('hello');
  });

  test('handles unreachable server', async () => {
    const result = await httpPost('http://localhost:1', '/anything', { data: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Server unreachable');
  });

  test('non-JSON 2xx response: ok:false with contract-violation error', async () => {
    const result = await httpPost(baseUrl, '/not-json');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2xx response with non-JSON body');
  });

  test('non-JSON ≥400 response: ok:false with HTTP-status error', async () => {
    const result = await httpPost(baseUrl, '/not-json-5xx');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });
});

describe('normalizeResponse — RFC 9457 + flat success', () => {
  test('RFC 9457 problem+json: surfaces title as error', async () => {
    const result = await httpGet(baseUrl, '/rfc9457-not-found');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Not found.');
    expect(result.instance).toBe('urn:uuid:11111111-1111-1111-1111-111111111111');
    expect(result.type).toBe('urn:ok:error:doc-not-found');
    expect(result.status).toBe(404);
    expect(result.detail).toBeUndefined();
  });

  test('RFC 9457 problem+json: detail field passthrough on a 5xx with detail', async () => {
    const result = await httpGet(baseUrl, '/rfc9457-with-detail');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.detail).toBe('Database connection pool exhausted; retry after 5s.');
  });

  test('RFC 9457 with extensions: preserves typed extension fields', async () => {
    const result = await httpGet(baseUrl, '/rfc9457-with-extensions');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Exists.');
    expect(result.colliding).toEqual([{ existing: 'a', incoming: 'b', to: 'c' }]);
  });

  test('flat D22 success (2xx, no ok wrapper): synthesizes ok=true', async () => {
    const result = await httpGet(baseUrl, '/d22-flat-success');
    expect(result.ok).toBe(true);
    expect(result.src).toBe('photo.png');
    expect(result.deduped).toBe(true);
  });

  test('2xx success whose body carries `type` + `title` is NOT misclassified as error', async () => {
    const result = await httpGet(baseUrl, '/d22-success-with-type-title');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('document');
    expect(result.title).toBe('My Page');
    expect(result.body).toBe('hello');
  });

  test('2xx top-level array body: surfaced under `data` field, not destructured', async () => {
    const result = await httpGet(baseUrl, '/array-body-2xx');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(['a', 'b', 'c']);
    expect(result['0']).toBeUndefined();
    expect(result.length).toBeUndefined();
  });

  test('4xx/5xx top-level array body: rejected as non-object error', async () => {
    const result = await httpGet(baseUrl, '/array-body-5xx');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('non-object body');
  });

  test('2xx null body: surfaced under `data` field as null', async () => {
    const result = await httpGet(baseUrl, '/null-body-2xx');
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  test('intermediary stray `ok: false` on 2xx: stripped + re-synthesized as ok:true', async () => {
    const result = await httpGet(baseUrl, '/intermediary-stray-ok-2xx');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('succeeded');
  });

  test('non-RFC-9457 5xx (proxy / non-our server): synthesizes `error` from body.message + preserves rest', async () => {
    const result = await httpGet(baseUrl, '/non-rfc9457-5xx');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('upstream blew up');
    expect(result.message).toBe('upstream blew up');
    expect(result.code).toBe('EX_BACKEND');
    expect(result.title).toBeUndefined();
  });

  test('non-RFC-9457 5xx with no error/message → generic HTTP-status sentence', async () => {
    const stripeServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ unrelated: true }, { status: 503 }),
    });
    try {
      const result = await httpGet(`http://127.0.0.1:${stripeServer.port}`, '/anything');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Server returned HTTP 503');
      expect(result.unrelated).toBe(true);
    } finally {
      stripeServer.stop();
    }
  });

  test('non-RFC-9457 4xx with body.error string → `error` ← body.error', async () => {
    const stubServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ error: 'rate limited', message: 'try again' }, { status: 429 }),
    });
    try {
      const result = await httpGet(`http://127.0.0.1:${stubServer.port}`, '/anything');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('rate limited');
    } finally {
      stubServer.stop();
    }
  });
});

describe('parseRenameCollidingPairs — defensive parsing at trust boundary', () => {
  test('non-array input → empty array', () => {
    expect(parseRenameCollidingPairs(undefined)).toEqual([]);
    expect(parseRenameCollidingPairs(null)).toEqual([]);
    expect(parseRenameCollidingPairs('not an array')).toEqual([]);
    expect(parseRenameCollidingPairs(42)).toEqual([]);
    expect(parseRenameCollidingPairs({ existing: 'a', incoming: 'b', to: 'c' })).toEqual([]);
  });

  test('array of valid entries → typed pairs', () => {
    const pairs = parseRenameCollidingPairs([
      { existing: 'a.md', incoming: 'A.md', to: 'A.md' },
      { existing: 'b.md', incoming: 'B.md', to: 'B.md' },
    ]);
    expect(pairs).toEqual([
      { existing: 'a.md', incoming: 'A.md', to: 'A.md' },
      { existing: 'b.md', incoming: 'B.md', to: 'B.md' },
    ]);
  });

  test('non-object entries filtered out', () => {
    const pairs = parseRenameCollidingPairs([
      { existing: 'a.md', incoming: 'A.md', to: 'A.md' },
      'not-an-object',
      null,
      42,
    ]);
    expect(pairs).toEqual([{ existing: 'a.md', incoming: 'A.md', to: 'A.md' }]);
  });

  test('entries with non-string fields filtered out', () => {
    const pairs = parseRenameCollidingPairs([
      { existing: 'a.md', incoming: 'A.md', to: 'A.md' },
      { existing: 1, incoming: 'B.md', to: 'B.md' },
      { existing: 'c.md', incoming: 'C.md' },
      { existing: 'd.md', incoming: null, to: 'D.md' },
      { existing: 'e.md', incoming: 'E.md', to: 'E.md', extra: 'tolerated' },
    ]);
    expect(pairs).toEqual([
      { existing: 'a.md', incoming: 'A.md', to: 'A.md' },
      { existing: 'e.md', incoming: 'E.md', to: 'E.md' },
    ]);
  });

  test('empty array → empty array', () => {
    expect(parseRenameCollidingPairs([])).toEqual([]);
  });
});

describe('okReservedPathRedirect', () => {
  test('.ok/skills/ path → skill-verb redirect naming write-skill', () => {
    const msg = okReservedPathRedirect('.ok/skills/research/SKILL');
    expect(msg).not.toBeNull();
    expect(msg).toContain('`skill` target');
    expect(msg).toContain('open-knowledge-write-skill');
  });

  test('leading slash is tolerated', () => {
    expect(okReservedPathRedirect('/.ok/skills/x/SKILL')).toContain('`skill` target');
  });

  test('.ok/templates/ path → template-verb redirect', () => {
    expect(okReservedPathRedirect('.ok/templates/note')).toContain('`template` target');
  });

  test('other .ok/ path → generic .ok redirect', () => {
    expect(okReservedPathRedirect('.ok/config/whatever')).toContain('not addressable as documents');
  });

  test('non-.ok path → null (normal docName error stands)', () => {
    expect(okReservedPathRedirect('meetings/standup')).toBeNull();
    expect(okReservedPathRedirect('docs/.hidden/x')).toBeNull();
  });
});
