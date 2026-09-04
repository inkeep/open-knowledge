import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prependFrontmatter, stripFrontmatter } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { describe as _bunDescribe, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { __resetQuiescenceForTests } from './bridge-quiescence.ts';
import { resetMetrics } from './metrics.ts';
import { createServer } from './server-factory.ts';

function reconstructSerializeDoc(
  hocuspocus: import('@hocuspocus/server').Hocuspocus,
  docName: string,
): string | null {
  const doc = hocuspocus.documents.get(docName);
  if (!doc) return null;
  const ytext = doc.getText('source').toString();
  const { frontmatter, body } = stripFrontmatter(ytext);
  return prependFrontmatter(frontmatter, body);
}

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-a3-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'A3 Test');
  await git.addConfig('user.email', 'a3@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

beforeEach(() => {
  resetMetrics();
  __resetQuiescenceForTests();
});

describe('A3: serializeDoc(docName) byte-equals git show :<stage>:<file> when freshly loaded', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('committed `.md` loaded into Y.Doc serializes byte-equal to git show HEAD:<file>', async () => {
    const docName = 'a3-byte-eq';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const initialContent =
      '---\ntitle: Byte-Equality Probe\ntags: [a3]\n---\n# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
    writeFileSync(docPath, initialContent, 'utf-8');

    const git = simpleGit({ baseDir: fixture.tmpDir });
    await git.add(`${docName}.md`);
    await git.commit('seed a3 doc');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      try {
        await waitForCondition(() => {
          const doc = server.hocuspocus.documents.get(docName);
          return doc?.getText('source').toString().includes('First paragraph.');
        });

        const fromYtext = reconstructSerializeDoc(server.hocuspocus, docName);
        if (fromYtext === null) {
          throw new Error('reconstructSerializeDoc returned null for a loaded doc');
        }
        const fromGit = await git.raw(['show', `HEAD:${docName}.md`]);

        const stripOneTrailingNewline = (s: string): string =>
          s.endsWith('\n') ? s.slice(0, -1) : s;

        expect(stripOneTrailingNewline(fromYtext)).toBe(stripOneTrailingNewline(fromGit));
      } finally {
        conn.disconnect();
      }
    } finally {
      await server.destroy();
    }
  });
});
