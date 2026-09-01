import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

const NNBSP = '\u202F';

interface UploadCase {
  id: string;
  uploaded: string;
  expected: string;
  requiredCodePoints: number[];
}

const UPLOAD_CASES: readonly UploadCase[] = [
  {
    id: 'macos-screenshot-nnbsp',
    uploaded: `Screenshot 2026-08-12 at 10.48.44${NNBSP}AM.png`,
    expected: 'Screenshot 2026-08-12 at 10.48.44_AM.png',
    requiredCodePoints: [0x202f],
  },
  {
    id: 'cjk-japanese',
    uploaded: '\u4F1A\u8B70\u30E1\u30E2.png',
    expected: '\u4F1A\u8B70\u30E1\u30E2.png',
    requiredCodePoints: [0x4f1a, 0x8b70, 0x30e1, 0x30e2],
  },
  {
    id: 'hangul',
    uploaded: '\uBB38\uC11C.png',
    expected: '\uBB38\uC11C.png',
    requiredCodePoints: [0xbb38, 0xc11c],
  },
  {
    id: 'cyrillic',
    uploaded: '\u041F\u0440\u043E\u0435\u043A\u0442.png',
    expected: '\u041F\u0440\u043E\u0435\u043A\u0442.png',
    requiredCodePoints: [0x041f, 0x0442],
  },
  {
    id: 'arabic',
    uploaded: '\u0642\u0635\u0629.png',
    expected: '\u0642\u0635\u0629.png',
    requiredCodePoints: [0x0642, 0x0635, 0x0629],
  },
  {
    id: 'emoji-astral',
    uploaded: 'party \u{1F389}.png',
    expected: 'party \u{1F389}.png',
    requiredCodePoints: [0x1f389],
  },
  {
    id: 'latin-precomposed',
    uploaded: 'caf\u00E9.png',
    expected: 'caf\u00E9.png',
    requiredCodePoints: [0x00e9],
  },
  {
    id: 'latin-decomposed',
    uploaded: 'cafe\u0301.png',
    expected: 'cafe\u0301.png',
    requiredCodePoints: [0x0301],
  },
  {
    id: 'plain-ascii',
    uploaded: 'plain-ascii.png',
    expected: 'plain-ascii.png',
    requiredCodePoints: [],
  },
];

function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
}

function codePointsOf(s: string): number[] {
  return [...s].map((c) => c.codePointAt(0) as number);
}

function hexPointsOf(s: string): string {
  return codePointsOf(s)
    .map((p) => p.toString(16).toUpperCase().padStart(4, '0'))
    .join(' ');
}

function assertFixtureIntact(id: string, value: string, required: number[]): void {
  const points = codePointsOf(value);
  for (const cp of required) {
    expect(points, `fixture ${id} lost U+${cp.toString(16).toUpperCase()}`).toContain(cp);
  }
  const hasNonAscii = points.some((p) => p > 0x7f);
  expect(hasNonAscii, `fixture ${id} non-ASCII presence`).toBe(required.length > 0);
}

beforeAll(async () => {
  server = await createTestServer();
  for (const c of UPLOAD_CASES) {
    const dir = join(server.contentDir, 'docs', c.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'guide.md'), '# Guide\n');
  }
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('multipart filename charset -- POST /api/upload', () => {
  test('fixture integrity: the uploaded names still carry their non-ASCII code points', () => {
    expect(codePointsOf(NNBSP)).toEqual([0x202f]);
    expect([...Buffer.from(NNBSP, 'utf8')]).toEqual([0xe2, 0x80, 0xaf]);

    for (const c of UPLOAD_CASES) {
      assertFixtureIntact(c.id, c.uploaded, c.requiredCodePoints);
    }
  });

  for (const c of UPLOAD_CASES) {
    test(`${c.id}: the uploaded filename survives the multipart decode`, async () => {
      const form = new FormData();
      form.append('parentDocName', `docs/${c.id}/guide.md`);
      form.append('file', new Blob([pngFixture()]), c.uploaded);

      const res = await fetch(`${base()}/api/upload`, { method: 'POST', body: form });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { src: string; path: string; deduped: boolean };
      expect(body.deduped).toBe(false);
      expect(
        hexPointsOf(body.src),
        `sent U+ ${hexPointsOf(c.uploaded)}\nas string "${c.uploaded}" -> got "${body.src}"`,
      ).toBe(hexPointsOf(c.expected));
      expect(body.src).toBe(c.expected);
      expect(body.path).toBe(`docs/${c.id}/${c.expected}`);

      const entries = readdirSync(join(server.contentDir, 'docs', c.id));
      expect(entries.map((e) => e.normalize('NFC'))).toContain(c.expected.normalize('NFC'));
    });
  }
});

const SKILL_NAME = 'charset-probe';

interface BundleCase {
  id: string;
  wire: string;
  expected: string;
  requiredCodePoints: number[];
}

function bundleCase(id: string, name: string, requiredCodePoints: number[]): BundleCase {
  return { id, wire: `references/${name}`, expected: name, requiredCodePoints };
}

const BUNDLE_CASES: readonly BundleCase[] = [
  bundleCase('macos-screenshot-nnbsp', `Screenshot 2026-08-12 at 10.48.44${NNBSP}AM.md`, [0x202f]),
  bundleCase('cjk-japanese', '\u4F1A\u8B70\u30E1\u30E2.md', [0x4f1a, 0x8b70, 0x30e1, 0x30e2]),
  bundleCase('cyrillic', '\u041F\u0440\u043E\u0435\u043A\u0442.md', [0x041f, 0x0442]),
  bundleCase('emoji-astral', 'party \u{1F389}.md', [0x1f389]),
  bundleCase('latin-precomposed', 'caf\u00E9.md', [0x00e9]),
  bundleCase('plain-ascii', 'plain-ascii.md', []),
];

const SKILL_MD = [
  '---',
  `name: ${SKILL_NAME}`,
  'description: Use when probing multipart filename decoding.',
  '---',
  '',
  '# Charset probe',
  '',
  'Bundle files carry non-ASCII names.',
  '',
].join('\n');

describe('multipart filename charset -- POST /api/skill-upload', () => {
  let uploadStatus = 0;
  let uploadDiagnostic = '';
  let bundleFiles: Array<{ path: string; text: string | null }> = [];

  beforeAll(async () => {
    const form = new FormData();
    form.append('files', new Blob([SKILL_MD]), `${SKILL_NAME}/SKILL.md`);
    for (const c of BUNDLE_CASES) {
      form.append('files', new Blob([`# ${c.id}\n`]), `${SKILL_NAME}/${c.wire}`);
    }

    const res = await fetch(`${base()}/api/skill-upload?scope=project`, {
      method: 'POST',
      body: form,
    });
    uploadStatus = res.status;
    uploadDiagnostic = await res.text();
    if (uploadStatus !== 200) return;

    const get = await fetch(`${base()}/api/skill?name=${SKILL_NAME}&scope=project`);
    if (get.status !== 200) {
      uploadDiagnostic = `GET /api/skill -> ${get.status} ${await get.text()}`;
      return;
    }
    const payload = (await get.json()) as {
      skill: { files?: Array<{ path: string; text: string | null }> };
    };
    bundleFiles = payload.skill.files ?? [];
  }, HARNESS_BOOT_TIMEOUT_MS);

  test('fixture integrity: the bundle names still carry their non-ASCII code points', () => {
    for (const c of BUNDLE_CASES) {
      assertFixtureIntact(c.id, c.expected, c.requiredCodePoints);
    }
  });

  test('the folder upload is accepted and the skill is readable', () => {
    expect(uploadStatus, uploadDiagnostic).toBe(200);
    expect(bundleFiles.length, uploadDiagnostic).toBe(BUNDLE_CASES.length);
  });

  for (const c of BUNDLE_CASES) {
    test(`${c.id}: the bundle filename survives the multipart decode`, () => {
      const entry = bundleFiles.find((f) => f.text === `# ${c.id}\n`);
      const listing = JSON.stringify(bundleFiles.map((f) => f.path));
      expect(entry, `no bundle entry carried the ${c.id} body; got ${listing}`).toBeDefined();
      const name = (entry?.path ?? '').slice((entry?.path ?? '').lastIndexOf('/') + 1);
      expect(
        hexPointsOf(name),
        `sent U+ ${hexPointsOf(c.expected)}\nas "${c.expected}" -> got "${name}"`,
      ).toBe(hexPointsOf(c.expected));
      expect(name).toBe(c.expected);
    });
  }
});
