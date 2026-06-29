import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import * as Y from 'yjs';
import { createServer } from './server-factory.ts';

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-phantom-doc-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function expectFileAbsentFor(
  filePath: string,
  { durationMs = 800, pollMs = 50 }: { durationMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      throw new Error(`Phantom file appeared at ${filePath} within the no-write window`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function waitForFileWithContent(
  filePath: string,
  needle: string,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = await Bun.file(filePath).text();
      if (content.includes(needle)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`File ${filePath} did not contain "${needle}" within ${timeoutMs}ms`);
}

describe('persistence onStoreDocument phantom-doc guard', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('opening a Y.Doc for a missing docName + empty transaction does NOT create a file', async () => {
    const ghostPath = join(fixture.contentDir, 'nonexistent-ghost.md');
    expect(existsSync(ghostPath)).toBe(false);

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      const conn = await server.hocuspocus.openDirectConnection('nonexistent-ghost');
      const serverDoc = server.hocuspocus.documents.get('nonexistent-ghost');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-phantom-guard' } },
      };
      serverDoc.transact(() => {
        serverDoc.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);
      }, connectionOrigin);

      await expectFileAbsentFor(ghostPath, { durationMs: 800 });

      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(existsSync(ghostPath)).toBe(false);
  });

  test('lifecycle="deleted-upstream" prevents persistence from resurrecting a removed file', async () => {
    const docPath = join(fixture.contentDir, 'mortal-doc.md');
    writeFileSync(docPath, '# Mortal\n\nReal content here.\n', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      const conn = await server.hocuspocus.openDirectConnection('mortal-doc');
      const serverDoc = server.hocuspocus.documents.get('mortal-doc');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      serverDoc.getMap('lifecycle').set('status', 'deleted-upstream');

      rmSync(docPath);
      expect(existsSync(docPath)).toBe(false);

      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-rm-after-load' } },
      };
      serverDoc.transact(() => {
        const frag = serverDoc.getXmlFragment('default');
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('NEW content that would resurrect the file')]);
        frag.push([para]);
      }, connectionOrigin);

      await expectFileAbsentFor(docPath, { durationMs: 800 });

      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(existsSync(docPath)).toBe(false);
  });

  test('opening a Y.Doc for a missing docName + non-empty transaction DOES create the file', async () => {
    const newDocPath = join(fixture.contentDir, 'new-doc.md');
    expect(existsSync(newDocPath)).toBe(false);

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      const conn = await server.hocuspocus.openDirectConnection('new-doc');
      const serverDoc = server.hocuspocus.documents.get('new-doc');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-real-content' } },
      };
      serverDoc.transact(() => {
        const frag = serverDoc.getXmlFragment('default');
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('first content from a fresh doc')]);
        frag.push([para]);
      }, connectionOrigin);

      await waitForFileWithContent(newDocPath, 'first content from a fresh doc');
      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(existsSync(newDocPath)).toBe(true);
    const content = await Bun.file(newDocPath).text();
    expect(content).toContain('first content from a fresh doc');
  });
});
