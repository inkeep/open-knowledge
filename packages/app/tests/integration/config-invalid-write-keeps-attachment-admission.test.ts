import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { parseCC1DerivedView, SYSTEM_DOC_NAME } from '../../src/lib/cc1';
import { createTestServer, pollUntil, type TestServer } from './test-harness';

describe('invalid external config write keeps the previous attachment admission', () => {
  let srv: TestServer;
  let sysDoc: Y.Doc;
  let sysProvider: HocuspocusProvider;
  let lintConfigFrames = 0;

  beforeAll(async () => {
    srv = await createTestServer({
      seedProjectConfigYml: 'content:\n  attachmentFolderPath: assets\n',
    });
    sysDoc = new Y.Doc();
    sysProvider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.port}/collab`,
      name: SYSTEM_DOC_NAME,
      document: sysDoc,
      onStateless: ({ payload }: { payload: string }) => {
        if (parseCC1DerivedView(payload)?.ch === 'lint-config') lintConfigFrames++;
      },
    });
    await pollUntil(() => sysProvider.isSynced === true, 10_000);
  }, 40_000);

  afterAll(async () => {
    sysProvider?.destroy();
    sysDoc?.destroy();
    await srv?.cleanup();
  });

  test('malformed YAML landing on disk leaves the configured folder admitted', async () => {
    const configPath = join(srv.contentDir, '.ok', 'config.yml');
    expect(srv.instance.contentFilter.isExcluded('assets/new.png')).toBe(false);

    const baseline = lintConfigFrames;
    writeFileSync(configPath, 'content: [unclosed\n', 'utf-8');
    await pollUntil(() => lintConfigFrames > baseline, 15_000);
    expect(srv.instance.contentFilter.isExcluded('assets/new.png')).toBe(false);

    writeFileSync(configPath, 'content:\n  attachmentFolderPath: media\n', 'utf-8');
    await pollUntil(() => srv.instance.contentFilter.isExcluded('media/pic.png') === false, 15_000);
    expect(srv.instance.contentFilter.isExcluded('assets/new.png')).toBe(true);

    mkdirSync(join(srv.contentDir, 'media'), { recursive: true });
    writeFileSync(join(srv.contentDir, 'media', 'pic.png'), 'image-bytes', 'utf-8');
    await pollUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${srv.port}/api/documents`);
      if (!response.ok) return false;
      const body = (await response.json()) as {
        documents?: Array<{ kind?: string; path?: string }>;
      };
      return body.documents?.some(
        (entry) => entry.kind === 'file' && entry.path === 'media/pic.png',
      );
    }, 15_000);
  }, 90_000);
});
