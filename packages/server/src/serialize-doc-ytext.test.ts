import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { describe as _vitestDescribe, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { __resetQuiescenceForTests } from './bridge-quiescence.ts';
import { resetMetrics } from './metrics.ts';
import { createServer } from './server-factory.ts';
import { waitWithinTestBudget } from './wait-within-test-budget.test-helper.ts';

const describe = process.env.CI ? _vitestDescribe.skip : _vitestDescribe;

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

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
      await waitWithinTestBudget(
        `reconciledBase for ${docName} to be seeded from disk`,
        () => server.durabilityState.getReconciledBase(docName) !== undefined,
        { timeoutMs: 5_000 },
      );
      expect(server.durabilityState.getReconciledBase(docName)).toBe(initialContent);

      const updatedContent = '---\n# Title Updated\n';
      writeFileSync(docPath, updatedContent, 'utf-8');

      await waitWithinTestBudget(
        `reconciledBase for ${docName} to pick up the updated bytes from disk`,
        () => server.durabilityState.getReconciledBase(docName) === updatedContent,
        { timeoutMs: 8_000 },
      );
      expect(server.durabilityState.getReconciledBase(docName)).toBe(updatedContent);

      expect(server.durabilityState.getReconciledBase(docName)).toContain('---\n');
      expect(server.durabilityState.getReconciledBase(docName)).not.toContain('***\n');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 20_000);
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
      await waitWithinTestBudget(
        `reconciledBase for ${docName} to be seeded with the initial bytes`,
        () => server.durabilityState.getReconciledBase(docName) === initialContent,
        { timeoutMs: 5_000 },
      );

      const updatedContent = '---\n# Title\n\nA __strong__ paragraph.\n\nNew block.\n';
      writeFileSync(docPath, updatedContent, 'utf-8');

      await waitWithinTestBudget(
        `reconciledBase for ${docName} to pick up the updated bytes from disk`,
        () => server.durabilityState.getReconciledBase(docName) === updatedContent,
        { timeoutMs: 8_000 },
      );

      const finalBase = server.durabilityState.getReconciledBase(docName);
      expect(finalBase).toBe(updatedContent);
      expect(finalBase).toContain('---\n');
      expect(finalBase).toContain('__strong__');

      await waitWithinTestBudget(
        `${docName}.md on disk to hold the updated bytes`,
        () => {
          if (!existsSync(docPath)) return false;
          return readFileSync(docPath, 'utf-8') === updatedContent;
        },
        { timeoutMs: 5_000 },
      );
      expect(readFileSync(docPath, 'utf-8')).toBe(updatedContent);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 20_000);
});
