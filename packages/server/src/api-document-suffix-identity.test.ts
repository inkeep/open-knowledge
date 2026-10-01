import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentReadSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const prefix = `suffix-${randomUUID()}`;
const documents = {
  'x.md': '# Plain\n\nPLAIN\n',
  'x.md.md': '# Dotted\n\nDOTTED\n',
  'lone.md.md': '# Lone\n\nLONE\n',
  'deep.md.md.MDX': '# Deep\n\nDEEP\n',
  'pair.md': '# Shadowed\n\nSHADOWED\n',
  'pair.mdx': '# Winner\n\nWINNER\n',
};
let contentDir: string;
let server: BootedServer;

beforeAll(async () => {
  contentDir = await mkdtemp(join(tmpdir(), 'ok-document-suffix-identity-'));
  await mkdir(join(contentDir, prefix));
  await Promise.all(
    Object.entries(documents).map(([file, content]) =>
      writeFile(join(contentDir, prefix, file), content),
    ),
  );
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(contentDir, { recursive: true, force: true });
});

const readCases = [
  ['x', 'x', documents['x.md']],
  ['x.md', 'x.md', documents['x.md.md']],
  ['x.md.md', 'x.md', documents['x.md.md']],
  ['lone.md', 'lone.md', documents['lone.md.md']],
  ['lone.md.md', 'lone.md', documents['lone.md.md']],
  ['deep.md.md', 'deep.md.md', documents['deep.md.md.MDX']],
  ['deep.md.md.MDX', 'deep.md.md', documents['deep.md.md.MDX']],
  ['pair', 'pair', documents['pair.mdx']],
  ['pair.mdx', 'pair', documents['pair.mdx']],
  ['pair.md', 'pair.md', documents['pair.md']],
] as const;

describe('dotted document identities over real serving boundaries', () => {
  test.each(readCases)(
    'HTTP read of %s preserves identity %s and its bytes',
    async (input, name, content) => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/document?docName=${encodeURIComponent(`${prefix}/${input}`)}`,
      );
      expect(response.status).toBe(200);
      const body = DocumentReadSuccessSchema.parse(await response.json());
      expect(body.docName).toBe(`${prefix}/${name}`);
      expect(body.content).toBe(content);
    },
  );

  test.each(readCases)(
    'direct connection for %s loads identity %s and its bytes',
    async (input, name, content) => {
      const connection = await server.serverInstance.hocuspocus.openDirectConnection(
        `${prefix}/${input}`,
      );
      try {
        expect(connection.document.name).toBe(`${prefix}/${name}`);
        expect(connection.document.getText('source').toString()).toBe(content);
      } finally {
        await connection.disconnect();
      }
    },
  );

  test('an agent write to the dotted identity persists only its own physical file', async () => {
    const replacement = '# Dotted updated\n\nUPDATED DOTTED\n';
    const response = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: `${prefix}/x.md`,
        markdown: replacement,
        position: 'replace',
        agentId: `suffix-writer-${randomUUID()}`,
      }),
    });
    expect(response.status, await response.text()).toBe(200);
    await expect
      .poll(() => readFile(join(contentDir, prefix, 'x.md.md'), 'utf8'))
      .toBe(replacement);
    expect(await readFile(join(contentDir, prefix, 'x.md'), 'utf8')).toBe(documents['x.md']);
  });
});
