import type { IncomingMessage } from 'node:http';
import { describe, expect, test } from 'vitest';
import { createMultipartParser } from './multipart.ts';

const BOUNDARY = 'okmultiparttestboundary';

const NNBSP = '\u202F';

interface FilenameCase {
  label: string;
  name: string;
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
    await expect(decodeFilename("filename*=UTF-8''%E4%BC%9A%E8%AD%B0.png")).resolves.toEqual([
      '\u4F1A\u8B70.png',
    ]);
  });

  test('degrades a genuinely latin1 filename to the replacement character', async () => {
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
    expect(codePointsOf(decoded as string)).not.toContain(0x00e9);
  });

  test('propagates a missing Content-Type instead of swallowing it', () => {
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
