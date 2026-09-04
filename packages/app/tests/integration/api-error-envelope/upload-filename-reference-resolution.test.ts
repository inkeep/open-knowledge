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

const NNBSP = '\u202F';
const SENT = `Screenshot 2026-08-12 at 10.48.44${NNBSP}AM.png`;
const EXPECTED = 'Screenshot 2026-08-12 at 10.48.44_AM.png';
const MOJIBAKE_LEAD = Buffer.from([0xc3, 0xa2]);

const CJK = '\u4F1A\u8B70\u30E1\u30E2.png';

function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
}

function hexOf(s: string): string {
  return [...Buffer.from(s, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function codePointsOf(s: string): number[] {
  return [...s].map((c) => c.codePointAt(0) as number);
}

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

    const entries = readdirSync(dir).filter((e) => e !== 'guide.md');
    expect(entries, `dir listing: ${JSON.stringify(readdirSync(dir))}`).toHaveLength(1);
    const stored = entries[0] as string;
    expect(hexOf(stored), `sent ${hexOf(SENT)} -> stored "${stored}"`).toBe(hexOf(EXPECTED));
    expect(
      Buffer.from(stored, 'utf8').includes(MOJIBAKE_LEAD),
      `stored name still carries the latin1 mojibake: "${stored}"`,
    ).toBe(false);

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
