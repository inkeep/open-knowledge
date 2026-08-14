/**
 * Unit-level contract for `createMultipartParser`.
 *
 * The end-to-end contract (client filename to asset basename / skill bundle
 * path) is pinned at full fidelity by
 * `packages/app/tests/integration/api-error-envelope/upload-filename-charset.test.ts`,
 * which drives real HTTP through both handlers. This file keeps the factory
 * itself honest at its own level: the decode it declares, the extended-parameter
 * path it must not disturb, and the throw it must not swallow.
 *
 * SOURCE-INTEGRITY RULE for this file: every non-ASCII character in a fixture is
 * written as a `\u` escape, never as a literal. U+202F NARROW NO-BREAK SPACE in
 * particular is silently rewritten to an ASCII space by several editors and
 * file-writing tools, and that rewrite would make these tests pass against the
 * exact defect they pin. The `fixture integrity` test re-derives the code points
 * at runtime so a fixture that lost its characters fails loudly rather than
 * quietly weakening every assertion below it.
 */

import type { IncomingMessage } from 'node:http';
import { describe, expect, test } from 'vitest';
import { createMultipartParser } from './multipart.ts';

const BOUNDARY = 'okmultiparttestboundary';

/**
 * U+202F NARROW NO-BREAK SPACE, what macOS 13+ puts before AM/PM in a screenshot
 * filename. UTF-8 `E2 80 AF`; read as latin1 it becomes U+00E2 U+0080 U+00AF.
 */
const NNBSP = '\u202F';

interface FilenameCase {
  label: string;
  name: string;
  /** Code points `name` must still contain at runtime. */
  requiredCodePoints: number[];
}

const FILENAME_CASES: readonly FilenameCase[] = [
  {
    label: 'macOS screenshot U+202F',
    name: `Screenshot 2026-08-12 at 10.48.44${NNBSP}AM.png`,
    requiredCodePoints: [0x202f],
  },
  {
    label: 'CJK',
    name: '\u4F1A\u8B70\u30E1\u30E2.png',
    requiredCodePoints: [0x4f1a, 0x8b70, 0x30e1, 0x30e2],
  },
  {
    label: 'Cyrillic',
    name: '\u041F\u0440\u043E\u0435\u043A\u0442.png',
    requiredCodePoints: [0x041f, 0x0442],
  },
  {
    label: 'astral emoji',
    name: 'party \u{1F389}.png',
    requiredCodePoints: [0x1f389],
  },
  {
    label: 'precomposed Latin',
    name: 'caf\u00E9.png',
    requiredCodePoints: [0x00e9],
  },
  { label: 'plain ASCII control', name: 'plain-ascii.png', requiredCodePoints: [] },
];

function headersFor(contentType: string): IncomingMessage {
  return { headers: { 'content-type': contentType } } as IncomingMessage;
}

/**
 * A minimal single-part multipart body. `dispositionParams` is spliced into the
 * `Content-Disposition` header verbatim so a test can send either a plain
 * `filename=` or an RFC 5987 extended `filename*=`.
 *
 * Encoded as UTF-8, which is what a browser or undici puts on the wire: raw
 * multi-byte sequences inside the quoted parameter value, never percent-encoded.
 */
function multipartBody(dispositionParams: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; ${dispositionParams}\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ),
    Buffer.from('payload', 'utf8'),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'),
  ]);
}

/** Feed a body through a factory-built parser and report every decoded name. */
function decodeFilenames(body: Buffer, files: number): Promise<string[]> {
  return new Promise((resolveP, reject) => {
    const bb = createMultipartParser(headersFor(`multipart/form-data; boundary=${BOUNDARY}`), {
      files,
    });
    const seen: string[] = [];
    bb.on('file', (_field, stream, info) => {
      seen.push(info.filename);
      stream.resume();
    });
    bb.on('error', reject);
    bb.on('close', () => resolveP(seen));
    bb.end(body);
  });
}

function decodeFilename(dispositionParams: string): Promise<string[]> {
  return decodeFilenames(multipartBody(dispositionParams), 1);
}

function codePointsOf(s: string): number[] {
  return [...s].map((c) => c.codePointAt(0) as number);
}

describe('createMultipartParser', () => {
  test('fixture integrity: the escapes still carry their code points', () => {
    expect(codePointsOf(NNBSP)).toEqual([0x202f]);
    expect([...Buffer.from(NNBSP, 'utf8')]).toEqual([0xe2, 0x80, 0xaf]);

    for (const c of FILENAME_CASES) {
      const points = codePointsOf(c.name);
      for (const cp of c.requiredCodePoints) {
        expect(points, `fixture ${c.label} lost U+${cp.toString(16).toUpperCase()}`).toContain(cp);
      }
      expect(
        points.some((p) => p > 0x7f),
        `fixture ${c.label} non-ASCII presence`,
      ).toBe(c.requiredCodePoints.length > 0);
    }
  });

  for (const c of FILENAME_CASES) {
    test(`decodes a plain \`filename=\` parameter as UTF-8: ${c.label}`, async () => {
      await expect(decodeFilename(`filename="${c.name}"`)).resolves.toEqual([c.name]);
    });
  }

  test('leaves the RFC 5987 extended `filename*` path alone', async () => {
    // Extended parameters carry their own charset and busboy decodes them
    // independently of `defParamCharset`, preferring them when present. RFC 7578
    // §4.2 forbids clients from sending them in a multipart/form-data body, so
    // this is a non-regression pin: hardcoding the default charset must not have
    // disturbed the path that was already correct.
    await expect(decodeFilename("filename*=UTF-8''%E4%BC%9A%E8%AD%B0.png")).resolves.toEqual([
      '\u4F1A\u8B70.png',
    ]);
  });

  test('degrades a genuinely latin1 filename to the replacement character', async () => {
    // Declaring UTF-8 is a choice against non-conformant senders: a client that
    // really did encode `café.png` as latin1 puts a bare 0xE9 on the wire, which
    // is not valid UTF-8. busboy's utf8 decoder is non-fatal, so that byte
    // becomes U+FFFD rather than throwing. Downstream this is what the release
    // note promises users, and the two upload paths diverge on it -- the asset
    // path's sanitizer maps U+FFFD to `_`, while a skill import keeps it -- so
    // pin the token here, where the decode actually happens, rather than let a
    // future busboy change quietly rewrite a documented behavior.
    const latin1Byte = Buffer.from([0xe9]);
    const body = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="caf`,
        'utf8',
      ),
      latin1Byte,
      Buffer.from(
        `.png"\r\nContent-Type: application/octet-stream\r\n\r\npayload\r\n--${BOUNDARY}--\r\n`,
        'utf8',
      ),
    ]);

    const [decoded] = await decodeFilenames(body, 1);

    expect(codePointsOf(decoded as string)).toEqual([
      0x63, 0x61, 0x66, 0xfffd, 0x2e, 0x70, 0x6e, 0x67,
    ]);
    // Specifically NOT U+00E9: that would mean the byte was read as latin1,
    // which is the default this factory exists to override.
    expect(codePointsOf(decoded as string)).not.toContain(0x00e9);
  });

  test('propagates a missing Content-Type instead of swallowing it', () => {
    // Each caller classifies this differently: the asset upload maps it to a
    // typed `urn:ok:error:malformed-upload`, the skill upload rejects raw. A
    // catch inside the factory would flatten both into one contract.
    expect(() => createMultipartParser({ headers: {} } as IncomingMessage, {})).toThrow(
      /Missing Content-Type/,
    );
  });

  test('propagates an unsupported Content-Type instead of swallowing it', () => {
    expect(() => createMultipartParser(headersFor('application/json'), {})).toThrow(
      /Unsupported content type/,
    );
  });

  test('passes the caller-supplied limits through to the parser', async () => {
    // The factory owns the charset; each call site still owns the ingress bounds
    // it sets for its own threat model.
    const twoParts = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\nA\r\n` +
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\n\r\nB\r\n` +
        `--${BOUNDARY}--\r\n`,
      'utf8',
    );
    await expect(decodeFilenames(twoParts, 1)).resolves.toEqual(['a.png']);
    await expect(decodeFilenames(twoParts, 2)).resolves.toEqual(['a.png', 'b.png']);
  });
});
