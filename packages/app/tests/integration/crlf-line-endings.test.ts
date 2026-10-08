import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  createTestClients,
  createTestServer,
  pollDiskContentStable,
  pollUntil,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const MISSION_LINES = [
  '# Mission',
  '',
  'Notre __mission__ est simple.',
  '',
  '## Objectifs',
  '',
  '+ un',
  '+ deux',
  '',
];

function findTextNodeContaining(
  node: Y.XmlFragment | Y.XmlElement,
  needle: string,
): Y.XmlText | null {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText && child.toString().includes(needle)) return child;
    if (child instanceof Y.XmlElement) {
      const found = findTextNodeContaining(child, needle);
      if (found) return found;
    }
  }
  return null;
}

const FRONTMATTER_LINES = ['---', 'title: Mission', '---', ''];

async function typeIntoHeadingFromDisk(
  eol: '\n' | '\r\n',
  withFrontmatter: boolean,
): Promise<string> {
  const docName = `crlf-line-endings-${crypto.randomUUID()}`;
  const filePath = join(server.contentDir, `${docName}.md`);
  const raw = [...(withFrontmatter ? FRONTMATTER_LINES : []), ...MISSION_LINES].join(eol);
  writeFileSync(filePath, raw, 'utf-8');

  const clients = await createTestClients(server.port, { count: 2, docName });
  try {
    await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
    const [typist, peer] = clients;

    for (const [offset, ch] of [
      [0, 'X'],
      [1, 'Y'],
    ] as const) {
      typist.doc.transact(() => {
        const heading = findTextNodeContaining(typist.fragment, 'Objectifs');
        if (!heading) throw new Error('no fragment text node containing "Objectifs"');
        heading.insert(offset, ch);
      });
    }

    const expected = raw.replace('## Objectifs', '## XYObjectifs');
    await pollUntil(() => peer.ytext.toString() === expected, 5000);
    return await pollDiskContentStable(filePath, (content) => content === expected, {
      timeoutMs: 10_000,
    });
  } finally {
    for (const client of clients) await client.cleanup();
  }
}

describe('CRLF documents keep their line endings from disk, through an edit, back to disk (PRD-9139)', () => {
  test.each([
    { label: 'without frontmatter', withFrontmatter: false },
    { label: 'with frontmatter', withFrontmatter: true },
  ])(
    'a WYSIWYG keystroke in a CRLF file persists only the typed characters, every line still CRLF ($label)',
    async ({ withFrontmatter }) => {
      const lf = await typeIntoHeadingFromDisk('\n', withFrontmatter);
      const crlf = await typeIntoHeadingFromDisk('\r\n', withFrontmatter);

      expect(crlf).toBe(lf.replaceAll('\n', '\r\n'));
      expect(crlf.split('\r\n').join('')).not.toContain('\n');
    },
  );
});
