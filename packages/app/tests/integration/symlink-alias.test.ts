import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { agentPatch, agentWriteMd, createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  // Create content dir with symlink BEFORE server startup so the seed walk
  // indexes them. `createTestServer({ contentDir })` then reuses the dir
  // (its file watcher will pick up the seed files on first scan).
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-symlink-test-')));
  writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
  writeFileSync(join(contentDir, 'target.md'), '# Target\n', 'utf-8');
  symlinkSync('target.md', join(contentDir, 'foo.md'));

  server = await createTestServer({ contentDir });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

// ─── /api/documents alias metadata response shape ───

describe('QA-009: /api/documents symlink metadata', () => {
  test('returns canonical entry with isSymlink=false and alias entry with correct metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    const body = (await res.json()) as {
      documents: Array<{
        docName: string;
        size: number;
        modified: string;
        isSymlink: boolean;
        canonicalDocName: string | null;
        targetPath: string | null;
      }>;
    };
    expect(Array.isArray(body.documents)).toBe(true);

    const target = body.documents.find((d) => d.docName === 'target');
    const foo = body.documents.find((d) => d.docName === 'foo');

    expect(target).toBeDefined();
    expect(target?.isSymlink).toBe(false);
    expect(target?.canonicalDocName).toBeNull();
    expect(target?.targetPath).toBeNull();
    expect(typeof target?.size).toBe('number');
    expect(typeof target?.modified).toBe('string');

    expect(foo).toBeDefined();
    expect(foo?.isSymlink).toBe(true);
    expect(foo?.canonicalDocName).toBe('target');
    expect(foo?.targetPath).toBe('target.md');
    expect(foo?.size).toBe(target?.size);
  });
});

// ─── /api/document?docName=<alias> resolves to canonical ───

describe('QA-010: document read via alias', () => {
  test('reading via alias returns same content as reading via canonical', async () => {
    // Write known content via canonical docName
    await agentWriteMd(server.port, '# Canonical Content', {
      docName: 'target',
      position: 'replace',
    });
    await wait(300);

    const [viaCan, viaAlias] = await Promise.all([
      fetch(`http://127.0.0.1:${server.port}/api/document?docName=target`).then(
        (r) => r.json() as Promise<{ docName: string; content: string }>,
      ),
      fetch(`http://127.0.0.1:${server.port}/api/document?docName=foo`).then(
        (r) => r.json() as Promise<{ docName: string; content: string }>,
      ),
    ]);

    expect(typeof viaCan.content).toBe('string');
    expect(typeof viaAlias.content).toBe('string');
    expect(viaAlias.content).toBe(viaCan.content);
    expect(viaCan.content).toContain('Canonical Content');
  });
});

// ─── agent-write-md via alias routes to canonical Y.Doc ───

describe('QA-012: agent-write-md via alias', () => {
  test('writing via alias docName modifies canonical document', async () => {
    await agentWriteMd(server.port, '# Via Alias', { docName: 'foo', position: 'replace' });
    await wait(300);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=target`);
    const body = (await res.json()) as { docName: string; content: string };
    expect(typeof body.content).toBe('string');
    expect(body.content).toContain('Via Alias');

    // Also verify through alias read
    const aliasRes = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=foo`);
    const aliasBody = (await aliasRes.json()) as { docName: string; content: string };
    expect(aliasBody.content).toBe(body.content);
  });
});

// ─── agent-write via alias ───

describe('QA-011: agent-write via alias', () => {
  test('raw agent-write with alias docName modifies canonical Y.Doc', async () => {
    const writeRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'foo', content: 'agent raw write content' }),
    });
    expect(writeRes.ok).toBe(true);
    await wait(300);

    const readRes = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=target`);
    const body = (await readRes.json()) as { docName: string; content: string };
    expect(typeof body.content).toBe('string');
    expect(body.content).toContain('agent raw write content');
  });
});

// ─── agent-patch via alias ───

describe('QA-013: agent-patch via alias', () => {
  test('patch via alias docName operates on canonical Y.Doc', async () => {
    // First write known content
    await agentWriteMd(server.port, '# Patchable Content\n\nold text here', {
      docName: 'target',
      position: 'replace',
    });
    await wait(300);

    // Patch via alias
    const result = await agentPatch(server.port, 'old text here', 'new text here', 'foo');
    expect(result.ok).toBe(true);
    await wait(300);

    // Verify via canonical read
    const readRes = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=target`);
    const body = (await readRes.json()) as { docName: string; content: string };
    expect(body.content).toContain('new text here');
    expect(body.content).not.toContain('old text here');
  });
});

// ─── Alias and canonical route to same content via API ───

describe('QA-002: alias and canonical API reads resolve to same Y.Doc content', () => {
  test('agent-write via alias is readable via canonical (shared content)', async () => {
    // Write via alias
    await agentWriteMd(server.port, '# Shared Content', { docName: 'foo', position: 'replace' });
    await wait(300);

    // Read via both — API resolveAlias ensures they return the same content
    const [viaCan, viaAlias] = await Promise.all([
      fetch(`http://127.0.0.1:${server.port}/api/document?docName=target`).then(
        (r) => r.json() as Promise<{ docName: string; content: string }>,
      ),
      fetch(`http://127.0.0.1:${server.port}/api/document?docName=foo`).then(
        (r) => r.json() as Promise<{ docName: string; content: string }>,
      ),
    ]);

    expect(viaCan.content).toBe(viaAlias.content);
    expect(viaCan.content).toContain('Shared Content');
  });

  test('agent-write via canonical is readable via alias', async () => {
    await agentWriteMd(server.port, '# From Canonical', { docName: 'target', position: 'replace' });
    await wait(300);

    const viaAlias = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=foo`).then(
      (r) => r.json() as Promise<{ docName: string; content: string }>,
    );
    expect(viaAlias.content).toContain('From Canonical');
  });
});

// ─── Persistence write preserves symlink on disk ───

describe('QA-005: persistence preserves symlink', () => {
  test('after CRDT edit persists, symlink remains intact and target has new content', async () => {
    await agentWriteMd(server.port, '# Persisted via Symlink', {
      docName: 'foo',
      position: 'replace',
    });
    // Wait for persistence debounce (test server uses 200ms)
    await wait(1000);

    // Symlink is still a symlink
    const stat = lstatSync(join(server.contentDir, 'foo.md'));
    expect(stat.isSymbolicLink()).toBe(true);

    // Target has the content
    const targetContent = readFileSync(join(server.contentDir, 'target.md'), 'utf-8');
    expect(targetContent).toContain('Persisted via Symlink');

    // Reading through symlink gives same content
    const fooContent = readFileSync(join(server.contentDir, 'foo.md'), 'utf-8');
    expect(fooContent).toBe(targetContent);
  });
});

// ─── Self-write detection after symlink resolution ───

describe('QA-015: self-write detection after symlink resolution', () => {
  test('persistence write does not trigger echo loop via watcher', async () => {
    // Write initial content
    await agentWriteMd(server.port, '# No Echo', { docName: 'foo', position: 'replace' });
    await wait(1000);

    // Read state immediately after persistence
    const res1 = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=target`);
    const body1 = (await res1.json()) as { docName: string; content: string };

    // Wait for any watcher-triggered re-import (which would be a bug)
    await wait(1500);

    // State should be unchanged — no echo loop
    const res2 = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=target`);
    const body2 = (await res2.json()) as { docName: string; content: string };
    expect(body2.content).toBe(body1.content);
  });
});
