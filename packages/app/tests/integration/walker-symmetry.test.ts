import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentFilter } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import { SyncEngine } from '../../../server/src/sync-engine.ts';
import { createTestServer, type TestServer } from './test-harness';

const corpus = [
  '.cursor/skills/SKILL.md',
  '.claude/skills/foo.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.vscode/notes.md',
  '.git/config',
  '.ok/config.yml',
  'node_modules/foo/README.md',
  '.next/build.md',
  'packages/.cursor/skills/SKILL.md',
  '.cursor/mcp.json',
  '.github/workflows/ci.yml',
  '.cursor/rules/some-rule.mdc',
  '.claude/settings.local.json',
];

let contentDir: string | null = null;
let server: TestServer | null = null;

function seed(path: string, body = '# doc\n'): void {
  if (!contentDir) throw new Error('contentDir not initialized');
  const full = join(contentDir, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf-8');
}

afterEach(async () => {
  if (server) await server.cleanup();
  server = null;
  if (contentDir) rmSync(contentDir, { recursive: true, force: true });
  contentDir = null;
});

describe('walker symmetry', () => {
  test('sync-engine disk gather and file-watcher seed walk admit the same corpus', async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-walker-symmetry-'));
    mkdirSync(join(contentDir, '.ok'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'config.yml'), '', 'utf-8');
    seed('test-doc.md');
    for (const path of corpus) {
      if (path.startsWith('.git/')) continue;
      seed(path, path.endsWith('.json') ? '{}' : '# doc\n');
    }

    const contentFilter = createContentFilter({ projectDir: contentDir, contentDir });
    const engine = new SyncEngine({
      projectDir: contentDir,
      contentDir,
      contentFilter,
      contentRoot: '.',
      syncEnabled: true,
    });
    const syncEngineSet = new Set(
      (engine as unknown as { gatherContentFilesSync: () => Array<{ contentRelPath: string }> })
        .gatherContentFilesSync()
        .map((entry) => entry.contentRelPath),
    );

    server = await createTestServer({ contentDir, keepContentDir: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents?: Array<{ kind?: string; docName?: string }> };
    const documents = body.documents ?? [];
    const fileWatcherSet = new Set(
      documents
        .filter((doc) => doc.kind === 'document' && doc.docName)
        .map((doc) => `${doc.docName}.md`),
    );

    const diagnostics: string[] = [];
    for (const path of corpus) {
      const syncHas = syncEngineSet.has(path);
      const watcherHas = fileWatcherSet.has(path);
      if (syncHas !== watcherHas)
        diagnostics.push(`${path}: sync-engine=${syncHas} file-watcher=${watcherHas}`);
    }

    expect(diagnostics).toEqual([]);
  });
});
