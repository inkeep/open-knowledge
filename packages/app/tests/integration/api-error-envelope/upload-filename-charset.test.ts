/**
 * Charset fidelity of the multipart `filename` parameter, end to end.
 *
 * Contract: a filename supplied by the client must reach the server's filename
 * handling as the same sequence of Unicode scalar values the client sent.
 * Browsers and Node/undici both put the name on the wire as raw UTF-8 bytes in
 * the plain `filename=` parameter of `Content-Disposition` -- never as an
 * RFC 5987 / RFC 2231 extended `filename*` -- so a parser that reads that
 * parameter as latin1 turns every multi-byte sequence into one mojibake code
 * point per byte, irreversibly.
 *
 * Both multipart entry points are covered, because the same decode decision is
 * made independently at each. Both land a BASENAME: busboy strips any directory
 * component from `filename` unless `preservePath` is set, and it is not set at
 * either site. What differs is only what happens after the decode:
 *   - `POST /api/upload`       -- the name is sanitized, then stored as an asset.
 *   - `POST /api/skill-upload` -- no sanitizer runs, so the decoded name must
 *     round-trip byte-identically.
 *
 * Fidelity: real server, real HTTP, real multipart serializer, real parser,
 * real disk. Nothing on the failing seam is stubbed. A test that mocked the
 * multipart parser would be asserting the stub's decoding, which is the very
 * behavior under test.
 *
 * SOURCE-INTEGRITY RULE for this file: every non-ASCII character in a fixture
 * is written as a `\u` escape, never as a literal. U+202F NARROW NO-BREAK SPACE
 * in particular is silently rewritten to an ASCII space by several editors and
 * file-writing tools, and that rewrite would make this suite pass against the
 * exact defect it pins. The `fixture integrity` tests re-derive the code points
 * at runtime, so a fixture that loses its characters fails loudly instead of
 * quietly weakening every assertion below it.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

/**
 * U+202F NARROW NO-BREAK SPACE -- what macOS 13+ puts before AM/PM in a
 * screenshot filename. UTF-8 `E2 80 AF`; read as latin1 it becomes the three
 * code points U+00E2 U+0080 U+00AF.
 */
const NNBSP = '\u202F';

interface UploadCase {
  /**
   * Also the per-case parent directory. Same-dir sha256 dedup and filesystem
   * collision-retry would otherwise let one case return a sibling's basename
   * and hide a decode failure behind a green assertion.
   */
  id: string;
  /** The name the client puts on the wire. */
  uploaded: string;
  /** The basename the server must produce. */
  expected: string;
  /**
   * Code points `uploaded` must still contain at runtime -- the guard against
   * a fixture that got normalized on its way into this file.
   */
  requiredCodePoints: number[];
}

const UPLOAD_CASES: readonly UploadCase[] = [
  {
    // The reported real-world case. U+202F is outside `sanitizeFilename`'s
    // whitelist, so it becomes `_` even after a correct decode -- that is the
    // sanitizer's pre-existing, deliberate policy and is not what this pins.
    // What must disappear is the U+00E2 mojibake a latin1 read produces.
    id: 'macos-screenshot-nnbsp',
    uploaded: `Screenshot 2026-08-12 at 10.48.44${NNBSP}AM.png`,
    expected: 'Screenshot 2026-08-12 at 10.48.44_AM.png',
    requiredCodePoints: [0x202f],
  },
  {
    // Japanese: the worst-affected class. Every code point is three UTF-8
    // bytes, so a latin1 read destroys essentially all of the information.
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
    // Astral plane -- a surrogate pair in UTF-16, four bytes in UTF-8.
    id: 'emoji-astral',
    uploaded: 'party \u{1F389}.png',
    expected: 'party \u{1F389}.png',
    requiredCodePoints: [0x1f389],
  },
  {
    // Precomposed and decomposed are DIFFERENT byte sequences and must both
    // survive unchanged; nothing on this path is entitled to normalize them.
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
    // Control: a fix that mangles the common case must not pass.
    id: 'plain-ascii',
    uploaded: 'plain-ascii.png',
    expected: 'plain-ascii.png',
    requiredCodePoints: [],
  },
];

/** Minimal valid PNG (1x1 transparent pixel). */
function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
}

function codePointsOf(s: string): number[] {
  return [...s].map((c) => c.codePointAt(0) as number);
}

/** Hex code points -- readable evidence of WHICH bytes diverged on failure. */
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
  // Keyed off `required`, not off the id: a case declares whether it is meant
  // to carry non-ASCII by whether it lists any code points. Deriving it from
  // the id instead would hold only while exactly one case is ASCII-only and is
  // named a particular way, and would misfire on the next ASCII case added.
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
    // A literal U+202F is the one character here that tooling silently
    // rewrites to U+0020. Pin its identity and its UTF-8 bytes.
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

      // The name the API reports is the name on disk. Compared under NFC
      // because a filesystem is entitled to store its own normal form of the
      // bytes we hand it; the byte-exact contract is the response assertion.
      const entries = readdirSync(join(server.contentDir, 'docs', c.id));
      expect(entries.map((e) => e.normalize('NFC'))).toContain(c.expected.normalize('NFC'));
    });
  }
});

// The folder-upload branch of skill import: each part's multipart filename is
// the file's path relative to the skill folder, exactly as a browser's
// `webkitRelativePath` supplies it. Unlike the asset path, no sanitizer runs on
// these names, so a correctly decoded one must round-trip byte-identically --
// U+202F included, since the sanitizer's whitelist is not in play here.
//
// The wire name carries a directory component because that is what the client
// actually sends; the assertion compares BASENAMES because busboy discards the
// directory unless `preservePath` is set. Whether that directory survives is a
// separate question from whether the bytes decode correctly, and pinning it
// here would make this suite fail on a correct charset fix.

const SKILL_NAME = 'charset-probe';

interface BundleCase {
  id: string;
  /** Path relative to the skill folder, as the client puts it on the wire. */
  wire: string;
  /** The bundle filename the server must produce. */
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
  /** Failure context surfaced into the assertion message, not the console. */
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
      // Correlate by the part's own body, not by scanning the aggregate name
      // list: a `toContain` over every returned name stays green even if two
      // parts swapped filenames, which is the corruption class under test.
      const entry = bundleFiles.find((f) => f.text === `# ${c.id}\n`);
      const listing = JSON.stringify(bundleFiles.map((f) => f.path));
      expect(entry, `no bundle entry carried the ${c.id} body; got ${listing}`).toBeDefined();
      const name = (entry?.path ?? '').slice((entry?.path ?? '').lastIndexOf('/') + 1);
      // Byte-exact rather than NFC-folded, unlike the asset assertion above:
      // the skill bundle's only observable is the directory listing, so folding
      // here would fold away the contract itself. APFS and ext4 both store the
      // bytes they are handed, so a normal-form difference surfacing here would
      // be a real finding about the substrate, not noise to be absorbed.
      expect(
        hexPointsOf(name),
        `sent U+ ${hexPointsOf(c.expected)}\nas "${c.expected}" -> got "${name}"`,
      ).toBe(hexPointsOf(c.expected));
      expect(name).toBe(c.expected);
    });
  }
});
