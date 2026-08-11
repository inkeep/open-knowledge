import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ForwardLinksSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

/**
 * The forward-links response projects local file/image references from the REAL
 * assessment index over the composed `bootServer` stack (real watcher seed →
 * DerivedDocumentIndex → LocalTargetIndex → HTTP). This is the composition
 * boundary the local-target sibling collection introduces: a mocked index would
 * leave the seam UNKNOWN, so the test boots the real server against on-disk
 * fixtures and reads the wire body through the shared core schema.
 */

const NOTES = [
  '# Notes',
  '',
  '![logo](./logo.png)',
  '',
  '![gone](./gone.png)',
  '',
  '![gone](./gone.png)',
  '',
  '[report](./report.pdf)',
  '',
  '[peer](./peer.md)',
  '',
  'Reference to [grab][data].',
  '',
  '[data]: ./data.csv',
  '',
].join('\n');

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-fwdlinks-localtargets-'));
  const dir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(dir, 'notes.md'), NOTES, 'utf-8');
  // peer.md is an admitted document; logo.png an admitted ordinary file. The
  // other three targets (gone.png, report.pdf, data.csv) are deliberately absent.
  writeFileSync(resolve(dir, 'peer.md'), '# Peer\n\nBody.\n', 'utf-8');
  writeFileSync(resolve(dir, 'logo.png'), 'not-a-real-png-just-needs-to-exist', 'utf-8');
  server = await bootCompositionRig(dir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('GET /api/forward-links — local-target sibling collection', () => {
  test('projects file/image references with exact/missing status and preserves the forwardLinks union', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/forward-links?docName=notes`);
    expect(res.status).toBe(200);

    // New payloads survive the HTTP schema round trip through the real contract.
    const body = ForwardLinksSuccessSchema.parse(await res.json());
    const localTargets = body.localTargets ?? [];

    // logo (exact image), gone ×2 (missing image), report.pdf (missing file
    // link), data.csv (missing reference-style file). peer.md is a document, so
    // it is absent here and present in forwardLinks instead.
    expect(localTargets.map((r) => r.href).sort()).toEqual([
      './data.csv',
      './gone.png',
      './gone.png',
      './logo.png',
      './report.pdf',
    ]);
    expect(localTargets.some((r) => r.targetKind === 'document')).toBe(false);
    expect(localTargets.some((r) => r.href === './peer.md')).toBe(false);

    expect(localTargets.find((r) => r.href === './logo.png')).toMatchObject({
      role: 'image',
      targetKind: 'file',
      status: 'exact',
      reason: null,
      resolvedTarget: 'logo.png',
    });
    expect(localTargets.find((r) => r.href === './report.pdf')).toMatchObject({
      role: 'link',
      sourceForm: 'markdown-inline',
      targetKind: 'file',
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'report.pdf',
    });

    const dataRow = localTargets.find((r) => r.href === './data.csv');
    expect(dataRow).toMatchObject({
      sourceForm: 'markdown-reference',
      status: 'missing',
      reason: 'no-such-file',
    });
    expect(dataRow?.definition?.label).toBe('data');

    // The document link stays a graph edge in the forwardLinks union.
    expect(body.forwardLinks).toContainEqual(
      expect.objectContaining({ kind: 'doc', docName: 'peer' }),
    );
  });

  test('repeated references to one missing image keep distinct navigable occurrences', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/forward-links?docName=notes`);
    const body = ForwardLinksSuccessSchema.parse(await res.json());
    const goneRows = (body.localTargets ?? []).filter((r) => r.href === './gone.png');
    expect(goneRows).toHaveLength(2);
    // Each occurrence carries its own source range — not one collapsed edge.
    expect(goneRows[0]?.range).not.toEqual(goneRows[1]?.range);
    expect(goneRows.every((r) => r.status === 'missing' && r.role === 'image')).toBe(true);
  });
});
