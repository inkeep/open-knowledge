import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';

let tmpRoot: string;
let server: BootedServer;
let contentDir: string;

async function writeDoc(docName: string, markdown: string): Promise<number> {
  const res = await rawRequest(server.port, '/api/agent-write-md', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docName, markdown, position: 'replace' }),
  });
  return res.status;
}

async function readDoc(docName: string): Promise<string> {
  const res = await rawRequest(server.port, `/api/document?docName=${encodeURIComponent(docName)}`);
  return res.body;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-room-canon-'));
  contentDir = tmpRoot;
  await writeFile(resolve(contentDir, 'notes.md'), '# original\n', 'utf-8');
  await writeFile(resolve(contentDir, 'pair.md'), 'MD-ORIGINAL\n', 'utf-8');
  await writeFile(resolve(contentDir, 'pair.mdx'), 'MDX-ORIGINAL\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('one file is backed by one collaboration document', () => {
  test('a write through the extension-qualified name is visible through the extension-less name', async () => {
    expect(await writeDoc('notes', 'CONTENT-A')).toBe(200);
    expect(await readDoc('notes')).toContain('CONTENT-A');

    expect(await writeDoc('notes.md', 'CONTENT-B')).toBe(200);

    expect(await readDoc('notes')).toContain('CONTENT-B');
    expect(await readDoc('notes')).not.toContain('CONTENT-A');
  }, 30_000);

  test('both spellings resolve to the same document, and it reaches disk', async () => {
    await writeDoc('notes.md', 'CONVERGED');

    expect(await readDoc('notes')).toContain('CONVERGED');
    expect(await readDoc('notes.md')).toContain('CONVERGED');
    expect(await readDoc('notes.md')).toContain('"docName":"notes"');

    await expect
      .poll(() => readFile(resolve(contentDir, 'notes.md'), 'utf-8'), { timeout: 15_000 })
      .toContain('CONVERGED');
  }, 30_000);

  test('no shadow file is created for the extension-qualified name', async () => {
    await writeDoc('notes.md', 'NO-SHADOW');
    await expect(readFile(resolve(contentDir, 'notes.md.md'), 'utf-8')).rejects.toThrow();
  }, 30_000);
});

describe('a genuine same-stem pair stays independently addressable', () => {
  test('the shadowed half is reachable by its qualified name, not collapsed onto its sibling', async () => {
    const viaStem = await readDoc('pair');
    const viaShadowed = await readDoc('pair.md');

    expect(viaStem).toContain('MDX-ORIGINAL');
    expect(viaShadowed).toContain('MD-ORIGINAL');
    expect(viaShadowed).not.toContain('MDX-ORIGINAL');
  }, 30_000);
});

describe('the file index is not polluted by an extension-qualified write', () => {
  test('a write addressed with the extension leaves one page row, not two', async () => {
    await writeDoc('notes.md', 'INDEX-CHECK');
    const pages = await rawRequest(server.port, '/api/pages');
    const rows = (pages.body.match(/"notes(\.md)?"/g) ?? []).filter(
      (r) => r === '"notes"' || r === '"notes.md"',
    );
    expect(rows).toContain('"notes"');
    expect(rows).not.toContain('"notes.md"');
  }, 30_000);
});
