import {
  describe as _bunDescribe,
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { __resetQuiescenceForTests } from './bridge-quiescence.ts';
import { resetMetrics } from './metrics.ts';
import { getReconciledBase } from './persistence.ts';
import { createServer } from './server-factory.ts';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

setDefaultTimeout(20_000);

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-fr34-'));
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

async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

beforeEach(() => {
  resetMetrics();
  __resetQuiescenceForTests();
});

describe('FR-34: serializeDoc returns ytext bytes verbatim', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('source-form bytes survive a within-branch reconcile (no in-flight ours edit)', async () => {
    const docName = 'fr34-doc-start-thematic';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const initialContent = '---\n# Title\n';
    writeFileSync(docPath, initialContent, 'utf-8');

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
      await waitForCondition(() => getReconciledBase(docName) !== undefined);
      expect(getReconciledBase(docName)).toBe(initialContent);

      const updatedContent = '---\n# Title Updated\n';
      writeFileSync(docPath, updatedContent, 'utf-8');

      await waitForCondition(() => getReconciledBase(docName) === updatedContent, {
        timeoutMs: 8_000,
      });
      expect(getReconciledBase(docName)).toBe(updatedContent);

      expect(getReconciledBase(docName)).toContain('---\n');
      expect(getReconciledBase(docName)).not.toContain('***\n');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('FR-35: setReconciledBase stores raw bytes uniformly across all paths', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('post-reconcile reconciledBase is the raw merge output (not canonical)', async () => {
    const docName = 'fr35-merge-output-raw';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const initialContent = '---\n# Title\n\nA __strong__ paragraph.\n';
    writeFileSync(docPath, initialContent, 'utf-8');

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
      await waitForCondition(() => getReconciledBase(docName) === initialContent);

      const updatedContent = '---\n# Title\n\nA __strong__ paragraph.\n\nNew block.\n';
      writeFileSync(docPath, updatedContent, 'utf-8');

      await waitForCondition(() => getReconciledBase(docName) === updatedContent, {
        timeoutMs: 8_000,
      });

      const finalBase = getReconciledBase(docName);
      expect(finalBase).toBe(updatedContent);
      expect(finalBase).toContain('---\n');
      expect(finalBase).toContain('__strong__');

      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        return readFileSync(docPath, 'utf-8') === updatedContent;
      });
      expect(readFileSync(docPath, 'utf-8')).toBe(updatedContent);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});
