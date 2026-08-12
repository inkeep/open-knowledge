/**
 * Contract: an invalid external write to `.ok/config.yml` (a merge conflict,
 * a hand-edit typo) must not degrade the live attachment-folder admission.
 * The config-file-watcher runs the consumer apply cycle for EVERY external
 * change, valid or not; when the on-disk config fails validation, the
 * attachment folder already applied stays in effect — never reset to the
 * sibling default. A regression that resets inside that error path would
 * silently stop attachment syncing for the rest of the session.
 *
 * Chokidar is REAL here, unlike the swallowed-echo suite in
 * `config-hot-apply-without-watcher-echo.test.ts` — the external-write path
 * under test IS the watcher. (The producer-notify path can never reach the
 * error branch: it only fires after a store outcome that leaves valid disk.)
 *
 * Happens-after signal: the server emits a CC1 `lint-config` frame at the end
 * of every project-config apply cycle, including one that rejected the config.
 * Waiting for a new frame proves the invalid write's cycle completed before
 * the admission assertion runs — a bare "still admitted" check could pass
 * merely because the watcher had not fired yet.
 */

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
    // Subscribing to `__system__` also materializes the doc server-side, which
    // CC1 broadcasts require — frames are dropped until it exists.
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
    // Boot applied the committed folder.
    expect(srv.instance.contentFilter.isExcluded('assets/new.png')).toBe(false);

    const baseline = lintConfigFrames;
    writeFileSync(configPath, 'content: [unclosed\n', 'utf-8');
    await pollUntil(() => lintConfigFrames > baseline, 15_000);
    // The apply cycle observed the malformed config and kept the previous
    // admission shape.
    expect(srv.instance.contentFilter.isExcluded('assets/new.png')).toBe(false);

    // A subsequent valid change must still apply: the rejected write degraded
    // nothing and wedged nothing.
    writeFileSync(configPath, 'content:\n  attachmentFolderPath: media\n', 'utf-8');
    await pollUntil(() => srv.instance.contentFilter.isExcluded('media/pic.png') === false, 15_000);
    expect(srv.instance.contentFilter.isExcluded('assets/new.png')).toBe(true);

    // The same live filter instance is owned by the real file-watcher and
    // document-list composition. Unreferenced attachments surface as generic
    // files; the richer asset row is reserved for Markdown references.
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
