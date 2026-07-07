/**
 * Tests for MCP shared helpers — textResult, routing helpers, httpGet, httpPost,
 * normalizeResponse boundary canonicalizer (RFC 9457 wire shapes).
 *
 * No CI-skip gate is applied here: this file imports nothing from `simple-git`
 * or any spawn-based fixture (the oven-sh/bun#11892 unreaped-children class of
 * failure that motivated CI-skips on `exec.test.ts` and similar MCP tool tests).
 * All tests in this file use the local `Bun.serve` test server or pure
 * functions, so they're safe to run in CI. Critical: `normalizeResponse` is
 * the boundary canonicalizer that translates RFC 9457 problem+json → flat
 * `{ ok: false, error }` for 18 MCP tool consumers; silently disabling its
 * tests in CI would let regressions like the 2xx-with-`type`+`title`
 * misclassification slip through.
 */
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
  // Coverage for the MCP-client text-hiding workaround. Claude and
  // Claude Desktop hide the text `content` stream when `structuredContent`
  // is present (anthropics/claude-code#55677); without auto-duplication into
  // `structuredContent.text`, every caller of this helper would have its
  // visible body silently dropped on those clients. Pin the contract — a
  // refactor removing the duplication would silently re-introduce
  // (`read_document` returning `{previewUrl: null}` with the file
  // contents missing). The key MUST NOT be `_`-prefixed: Claude-class
  // clients strip underscore-prefixed keys from `structuredContent`
  // (MCP-spec `_meta` reserved convention, generalized) before the model
  // sees it.

  test('wraps body in MCP content array AND mirrors it under structuredContent.text', () => {
    const result = textPlusStructured('hello', { previewUrl: null });
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.structuredContent).toEqual({ text: 'hello', previewUrl: null });
  });

  test('does not surface body under an underscore-prefixed key (PRD-6663 regression guard)', () => {
    // Direct guard against the original regression: when the body
    // mirror was emitted as `_text`, Claude stripped it and the agent
    // saw only `{previewUrl: null}`. Pin that no `_`-prefixed key ever
    // appears in `structuredContent`.
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
    // Escape hatch for tools whose structured `text` legitimately diverges
    // from the visible body (none today; reserved). The caller spread
    // lands on top of the auto-mirror so the override wins.
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
    // Regression guard for callers like delete-template / write-template
    // that pass a small `{ result }` shape — the body mirror must not
    // depend on the structured payload carrying any particular keys.
    const result = textPlusStructured('done', {});
    expect(result.structuredContent).toEqual({ text: 'done' });
  });
});

describe('outputSchemaWithText — PRD-6655 / PRD-6656 schema-level mirror declaration', () => {
  // Regression guard: every tool that registers via `registerTool` and returns
  // via `textPlusStructured` MUST run its outputSchema through this helper, or
  // the auto-injected `text` mirror violates the client-side AJV strictness
  // check (`data must NOT have additional properties`). The helper is the
  // single source of truth for the mirror field's schema declaration; if it
  // gets dropped or renamed accidentally, all eight affected tools regress at
  // once.

  test('declares `text` alongside the caller-supplied fields without mutating them', () => {
    const base = {
      result: z.string(),
      count: z.number(),
    };
    const augmented = outputSchemaWithText(base);
    // `text` is laid down first; caller fields follow. Order matters only
    // for the override case (next test) — JSON-schema emission treats the
    // keys as a set.
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
    // Mirrors the runtime escape hatch in `textPlusStructured` (the existing
    // 'caller-provided `text` field overrides the auto-duplicated body'
    // test): the structured-content layer lets the caller win, so the
    // schema layer must too. Without this contract, a caller that hands a
    // tighter `text` schema (literal type, richer description) would be
    // silently stomped by `TEXT_CHANNEL_FIELD`.
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
    // `foo.md.md` must fully normalize to `foo` — a single strip left the key
    // `foo.md`, which the create then wrote to disk as the doubled `foo.md.md`.
    // Only supported extensions are stripped, so unrelated dotted names stay
    // intact (see "leaves unrelated dotted names untouched").
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
    // A docName like "v1.0" is a legitimate extension-less name with a dot.
    const result = normalizeDocName('releases/v1.0');
    expect(result).toEqual({ ok: true, docName: 'releases/v1.0' });
  });

  test('handles root-level docName with .md', () => {
    const result = normalizeDocName('PROJECT.md');
    expect(result).toEqual({ ok: true, docName: 'PROJECT' });
  });

  // Structurally-invalid names are rejected before the write path rather than
  // producing junk / hidden / unaddressable files (or a 500 in the doc layer).
  for (const raw of ['   ', '.', '..', 'a/', '.foo', 'x\ty', ' leading', 'trailing ']) {
    test(`rejects malformed docName ${JSON.stringify(raw)}`, () => {
      const result = normalizeDocName(raw);
      expect(result.ok).toBe(false);
    });
  }

  test('rejects a docName that is only an extension', () => {
    // ".md" strips to an empty candidate, which is invalid.
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
    // resolveCwd mimics the production walk-up: any explicit path resolves to
    // the project root. executionCwd must preserve the passed subdirectory.
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

// ── HTTP helpers — test against a local test server ──

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  testServer = Bun.serve({
    port: 0, // random available port
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);

      // Flat 2xx success body (wire shape — no `ok` wrapper). The
      // canonicalizer synthesizes `ok: true` from the HTTP status; the
      // body stays a record of the handler's payload.
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
        // Respond after 100ms (won't timeout with our 30s limit)
        return new Promise((resolve) =>
          setTimeout(() => resolve(Response.json({ data: 'late' })), 100),
        );
      }
      // RFC 9457 problem+json error (4xx) — wire shape.
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
      // RFC 9457 with an extension member alongside canonical fields.
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
      // RFC 9457 with `detail` field present — fixture for the canonicalizer
      // detail-passthrough test (RFC 9457 §3.1.5: detail is an advisory
      // human-readable elaboration of the problem).
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
      // Flat 2xx success body — no { ok: true } wrapper.
      if (url.pathname === '/d22-flat-success') {
        return Response.json({ src: 'photo.png', deduped: true });
      }
      // 2xx success whose flat body happens to carry both `type` and
      // `title` strings — collides with the RFC 9457 discriminator. Future-
      // proofs the canonicalizer against schemas that legitimately use
      // these field names (e.g. resources with type='document', title=...).
      if (url.pathname === '/d22-success-with-type-title') {
        return Response.json({ type: 'document', title: 'My Page', body: 'hello' });
      }
      // 2xx success body that's a top-level array — surfaced under a
      // `data` field so a future list-all endpoint returning `[…]`
      // reaches consumers as `result.data` rather than being
      // destructured into `{0: item, 1: item, length: N}` or
      // misclassified as a non-object error.
      if (url.pathname === '/array-body-2xx') {
        return Response.json(['a', 'b', 'c']);
      }
      // 4xx/5xx with a top-level array body — no structured shape to
      // canonicalize. Surfaces as the generic non-object error.
      if (url.pathname === '/array-body-5xx') {
        return Response.json(['a', 'b', 'c'], { status: 500 });
      }
      // 2xx with a `null` body — same treatment as array: surface under
      // `data` so the canonicalizer doesn't destructure `null` into an
      // object spread or reject it as a non-object.
      if (url.pathname === '/null-body-2xx') {
        return Response.json(null);
      }
      // Non-RFC-9457 5xx body (reverse proxy / load balancer / non-our
      // server in the network path). The canonicalizer's last branch
      // preserves the body verbatim and forces `ok: false` — it doesn't
      // manufacture an `error` string the consumer didn't ask for. MCP
      // tools own their fallback strings.
      if (url.pathname === '/non-rfc9457-5xx') {
        return Response.json({ message: 'upstream blew up', code: 'EX_BACKEND' }, { status: 502 });
      }
      // 2xx body that carries a stray `ok: false` field — boundary defense
      // against an intermediary that wraps a 2xx response. The
      // canonicalizer must strip the body's `ok` and re-add its own
      // `ok: true` synthesized from the HTTP status, so MCP consumers
      // never see a wrong-typed `ok: false` at 200.
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

// ── Wire-shape canonicalization (RFC 9457 + flat success) ──
//
// Exercises the production wire shapes the MCP shim's `normalizeResponse`
// boundary canonicalizer must translate: flat 2xx success bodies, RFC 9457
// problem+json on 4xx/5xx, and the intermediary fallback for shapes our
// own server never emits but a reverse proxy / load balancer might.

describe('normalizeResponse — RFC 9457 + flat success', () => {
  test('RFC 9457 problem+json: surfaces title as error', async () => {
    const result = await httpGet(baseUrl, '/rfc9457-not-found');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Not found.');
    // Correlation ID preserved so MCP consumers can surface it for support
    // / debugging (grep handle between HTTP response and Pino log).
    expect(result.instance).toBe('urn:uuid:11111111-1111-1111-1111-111111111111');
    // `type` URN preserved for consumers that want programmatic dispatch
    // on the kind of error (RFC 9457 §4) rather than parsing the human-
    // readable `title` string. Bounded to the closed `ProblemType` enum,
    // so consumers can rely on it as a stable contract.
    expect(result.type).toBe('urn:ok:error:doc-not-found');
    // `status` preserved for retry-class branching (4xx → fix-and-retry,
    // 5xx → backoff-retry). Information-preservation hygiene at the
    // canonicalizer — the prior `void status` discard was reverted so
    // SDK + MCP-tool consumers can branch on retry strategy without
    // maintaining a URN→status map.
    expect(result.status).toBe(404);
    // `detail` preserved when present in the problem+json body — RFC 9457
    // §3.1.4 advisory detail; consumers may surface to user-facing
    // diagnostics or log channels.
    expect(result.detail).toBeUndefined();
  });

  test('RFC 9457 problem+json: detail field passthrough on a 5xx with detail', async () => {
    // Companion to the not-found test: pin both `status: 5xx` AND
    // `detail` preservation in one fixture. Without explicit assertions
    // here, a future refactor that adds a `void detail;` discard (or
    // accidentally drops `detail` from the canonicalizer's output spread)
    // would silently regress the diagnostic field. Uses the dedicated
    // /rfc9457-with-detail fixture which includes the `detail` advisory
    // string — RFC 9457 §3.1.5 — alongside the canonical envelope fields.
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
    // Regression: the canonicalizer must consult `res.ok` BEFORE the RFC
    // 9457 discriminator. A flat 2xx body with both `type: string` and
    // `title: string` (e.g., a future resource schema with type='document',
    // title='My Page') would otherwise be silently routed through the
    // error path and break every consumer that reads `result.ok`.
    const result = await httpGet(baseUrl, '/d22-success-with-type-title');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('document');
    expect(result.title).toBe('My Page');
    expect(result.body).toBe('hello');
  });

  test('2xx top-level array body: surfaced under `data` field, not destructured', async () => {
    // `typeof [] === 'object'` in JS, so a naive spread would emit
    // `{ok: true, '0': 'a', '1': 'b', '2': 'c', length: 3}` — wire-shape
    // garbage for MCP consumers. The canonicalizer routes 2xx
    // arrays/null/primitives through a `data` field so a future list-all
    // endpoint returning `[…]` reaches consumers as `result.data`.
    const result = await httpGet(baseUrl, '/array-body-2xx');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(['a', 'b', 'c']);
    expect(result['0']).toBeUndefined();
    expect(result.length).toBeUndefined();
  });

  test('4xx/5xx top-level array body: rejected as non-object error', async () => {
    // Symmetric to the 2xx case but on the error branch. There's no
    // RFC 9457 problem+json shape here, no canonical fields to extract,
    // so surface as the generic non-object error.
    const result = await httpGet(baseUrl, '/array-body-5xx');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('non-object body');
  });

  test('2xx null body: surfaced under `data` field as null', async () => {
    // Pin the contract — the prior order misclassified `null` as a
    // non-object error even on 2xx. After moving the res.ok branch
    // first, null is preserved under `data`.
    const result = await httpGet(baseUrl, '/null-body-2xx');
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  test('intermediary stray `ok: false` on 2xx: stripped + re-synthesized as ok:true', async () => {
    // Boundary defense: an intermediary (reverse proxy / load balancer)
    // could in principle wrap a 2xx response with `{ok: false, ...}`
    // (rare but unblockable at the wire — RFC 9457 §3.2 doesn't reserve
    // `ok` as an extension key). The canonicalizer strips body's `ok`
    // and re-adds its own from `res.ok` so MCP consumers never see a
    // wrong-typed `ok: false` at HTTP 200. Pin the contract — a refactor
    // simplifying the 2xx path to `{ok: true, ...record}` would let the
    // body's `ok` win the spread and produce a false failure report.
    const result = await httpGet(baseUrl, '/intermediary-stray-ok-2xx');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('succeeded');
  });

  test('non-RFC-9457 5xx (proxy / non-our server): synthesizes `error` from body.message + preserves rest', async () => {
    // A reverse proxy or non-our server in the network path can return
    // a 5xx with a body shape that doesn't match RFC 9457. The
    // canonicalizer forces `ok: false` (the MCP boolean contract),
    // preserves the body fields, AND guarantees an `error` string —
    // sourced from `body.error` first, then `body.message`, then a
    // generic HTTP-status sentence. The 12 MCP-tool consumers that
    // interpolate `result.error` directly never surface
    // `'Error: undefined'` for these intermediary responses.
    const result = await httpGet(baseUrl, '/non-rfc9457-5xx');
    expect(result.ok).toBe(false);
    // `body.error` was absent, `body.message` present → `error` ←
    // `message`. Other body fields preserved.
    expect(result.error).toBe('upstream blew up');
    expect(result.message).toBe('upstream blew up');
    expect(result.code).toBe('EX_BACKEND');
    expect(result.title).toBeUndefined();
  });

  test('non-RFC-9457 5xx with no error/message → generic HTTP-status sentence', async () => {
    // Pin the deepest fallback. Body has no `error`, no `message`, no
    // `title` — consumers still get a non-undefined string they can
    // interpolate.
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
    // Body's own `error` field wins over `message` (priority 1 of 3).
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
  // The function sits between untyped `normalizeResponse` output and the
  // typed MCP-tool consumers that render collision pairs in user-facing
  // error messages. Each branch must be pinned: a regression that relaxes
  // the type guard would let malformed entries through and surface as
  // `undefined` fields in the rendered message.

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
      // Legitimate
      { existing: 'a.md', incoming: 'A.md', to: 'A.md' },
      // Numeric field — rejected
      { existing: 1, incoming: 'B.md', to: 'B.md' },
      // Missing field — rejected
      { existing: 'c.md', incoming: 'C.md' },
      // Null field — rejected
      { existing: 'd.md', incoming: null, to: 'D.md' },
      // Extra fields are tolerated as long as required ones are strings
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
