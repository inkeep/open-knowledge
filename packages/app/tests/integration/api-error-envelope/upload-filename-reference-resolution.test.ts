/**
 * What the reader ends up with: an asset whose name survived the multipart
 * decode, a markdown reference that resolves to it, and the same result through
 * the in-process transport.
 *
 * `upload-filename-charset.test.ts` pins the decode itself, at the HTTP
 * boundary, across a wide table of scripts. This file is narrower and reaches
 * one step further in three directions it deliberately leaves open:
 *
 *   1. RAW on-disk bytes, unfolded. The charset suite compares the directory
 *      listing under NFC, because a filesystem is entitled to store its own
 *      normal form. That fold is correct there, but it means no test asserts the
 *      exact byte sequence a reader's filesystem holds.
 *   2. The reference INSIDE a document. The charset suite stops at the API
 *      response. Nothing pinned that the link written into markdown resolves to
 *      a file that exists, which is the outcome a user actually experiences.
 *   3. The in-process arm of the same handler. The MCP `write` tool encodes its
 *      own multipart body and dispatches through `localApi` rather than a
 *      socket. Coverage there was previously by composition only (a separate
 *      test proves the two transports deliver byte-identical bodies).
 *
 * SOURCE-INTEGRITY RULE: every non-ASCII character is a `\u` escape. A literal
 * U+202F is silently rewritten to an ASCII space by several editors and
 * file-writing tools, and that rewrite would make this file pass against the
 * exact defect it pins.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import {
  agentWriteMd,
  createTestServer,
  pollUntil,
  readTestDoc,
  type TestServer,
} from '../test-harness';

let server: TestServer;

/** U+202F NARROW NO-BREAK SPACE, as macOS puts it before AM/PM. */
const NNBSP = '\u202F';
/** What the client sends. */
const SENT = `Screenshot 2026-08-12 at 10.48.44${NNBSP}AM.png`;
/** What the server must store: no mojibake, U+202F sanitized to `_`. */
const EXPECTED = 'Screenshot 2026-08-12 at 10.48.44_AM.png';
/** U+00E2 in UTF-8 - the leading byte pair of the mojibake this fix removes. */
const MOJIBAKE_LEAD = Buffer.from([0xc3, 0xa2]);

const CJK = '\u4F1A\u8B70\u30E1\u30E2.png';

/** Minimal valid PNG (1x1 transparent pixel). */
function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
}

/** Hex bytes - readable evidence of WHICH bytes diverged on failure. */
function hexOf(s: string): string {
  return [...Buffer.from(s, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function codePointsOf(s: string): number[] {
  return [...s].map((c) => c.codePointAt(0) as number);
}

/**
 * Seed a per-case parent directory. One per case for the same reason the
 * charset suite uses one: the fixture bytes are identical, so a shared
 * destination would let same-dir sha256 dedup return a sibling's basename and
 * hide a decode failure behind a green assertion.
 */
function seedDir(id: string): string {
  const dir = join(server.contentDir, 'docs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'guide.md'), '# Guide\n');
  return dir;
}

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('uploaded asset names, from the wire to the reader', () => {
  test('fixture integrity: the sent names still carry their non-ASCII code points', () => {
    // U+202F is the one character here that tooling silently rewrites to
    // U+0020. Were that to happen, every assertion below would still compare a
    // sent name against a stored name and still pass -- while no longer
    // exercising a multi-byte sequence at all. Pin its identity and its bytes
    // so the loss fails here instead of quietly emptying the suite.
    expect(codePointsOf(NNBSP)).toEqual([0x202f]);
    expect([...Buffer.from(NNBSP, 'utf8')]).toEqual([0xe2, 0x80, 0xaf]);
    expect(codePointsOf(SENT)).toContain(0x202f);
    expect(codePointsOf(CJK)).toEqual([0x4f1a, 0x8b70, 0x30e1, 0x30e2, 0x2e, 0x70, 0x6e, 0x67]);
  });

  test('the bytes on disk are the bytes the reader gets, and the reference resolves', async () => {
    const id = 'ref-resolution';
    const dir = seedDir(id);

    const form = new FormData();
    form.append('parentDocName', `docs/${id}/guide.md`);
    form.append('file', new Blob([pngFixture()]), SENT);
    const res = await fetch(`${server.baseUrl}/api/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { src: string; deduped: boolean };
    expect(body.deduped).toBe(false);

    // (1) Raw bytes on disk, no NFC fold.
    const entries = readdirSync(dir).filter((e) => e !== 'guide.md');
    expect(entries, `dir listing: ${JSON.stringify(readdirSync(dir))}`).toHaveLength(1);
    const stored = entries[0] as string;
    expect(hexOf(stored), `sent ${hexOf(SENT)} -> stored "${stored}"`).toBe(hexOf(EXPECTED));
    expect(
      Buffer.from(stored, 'utf8').includes(MOJIBAKE_LEAD),
      `stored name still carries the latin1 mojibake: "${stored}"`,
    ).toBe(false);

    // (2) The reference inside the document. This is what the editor does with
    // the API response: mint a markdown image whose target is the returned
    // `src`. Persistence is debounced, so poll rather than read straight after.
    await agentWriteMd(server.port, `\n![shot](${body.src})\n`, {
      docName: `docs/${id}/guide`,
      position: 'append',
    });
    await pollUntil(() => readTestDoc(server.contentDir, `docs/${id}/guide`).includes('![shot]('));

    const doc = readTestDoc(server.contentDir, `docs/${id}/guide`);
    const ref = /!\[shot\]\(([^)]*)\)/.exec(doc)?.[1];
    expect(ref, `document was: ${JSON.stringify(doc)}`).toBeDefined();

    const target = decodeURIComponent(ref as string);
    expect(hexOf(target), `reference "${target}" vs on-disk "${stored}"`).toBe(hexOf(stored));
    expect(existsSync(join(dir, target)), `reference does not resolve: "${target}"`).toBe(true);
  });

  test.each([
    ['nnbsp', SENT, EXPECTED],
    ['cjk', CJK, CJK],
  ])('the in-process transport decodes identically to the socket: %s', async (id, sent, expected) => {
    const dir = seedDir(`localapi-${id}`);

    // Byte-for-byte the encoding `mcp/tools/write.ts` performs for an asset
    // write: a Node FormData serialized once through `new Request(...)`, then
    // handed to `localApi` as raw bytes plus the boundary-bearing
    // content-type.
    const form = new FormData();
    form.append('parentDocName', `docs/localapi-${id}/guide.md`);
    form.append('file', new Blob([pngFixture()]), sent);
    const encoded = new Request('http://localhost/api/upload', { method: 'POST', body: form });
    const contentType = encoded.headers.get('content-type') ?? 'multipart/form-data';
    const bytes = new Uint8Array(await encoded.arrayBuffer());

    const out = await server.instance.localApi('POST', '/api/upload', { body: bytes, contentType });
    expect(out, 'localApi returned null - /api/upload left the dispatch allowlist').not.toBeNull();
    expect(out?.status, out?.bodyText).toBe(200);

    const parsed = JSON.parse(out?.bodyText ?? '{}') as { src: string; deduped: boolean };
    expect(parsed.deduped).toBe(false);
    expect(hexOf(parsed.src), `sent ${hexOf(sent)} -> got "${parsed.src}"`).toBe(hexOf(expected));
    expect(existsSync(join(dir, parsed.src))).toBe(true);
  });
});
