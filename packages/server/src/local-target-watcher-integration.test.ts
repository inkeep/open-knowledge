import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import { DerivedDocumentIndex } from './derived-document-index.ts';
import { startWatcher } from './file-watcher.ts';
import { localTargetInventoryFromWatcher } from './local-target-inventory.ts';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('local-target watcher integration', () => {
  test('startup seeds ordinary-file existence from the real watcher inventory', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-lti-watch-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'assets'), { recursive: true });
    writeFileSync(
      join(contentDir, 'src.md'),
      'Report [here](assets/report.pdf), image ![p](assets/logo.png), gone [x](assets/missing.pdf).\n',
    );
    writeFileSync(join(contentDir, 'assets', 'report.pdf'), '%PDF-1.4 test\n');
    writeFileSync(join(contentDir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const contentFilter = createContentFilter({ projectDir, contentDir });

    const watcher = await startWatcher(contentDir, async () => {}, contentFilter);
    const index = new DerivedDocumentIndex({
      projectDir,
      contentDir,
      contentFilter,
      getGlobalSkillRoots: () => [],
      signalChannel: () => {},
      getLocalTargetInventory: () => localTargetInventoryFromWatcher(watcher, contentDir),
    });
    cleanups.push(async () => {
      await index.close();
      await watcher.unsubscribe();
      rmSync(projectDir, { recursive: true, force: true });
    });

    const startup = index.beginStartup('main');
    await startup.backlinksReady;
    await index.settleStartupAfterWatcherSeed();

    const status = Object.fromEntries(
      (await index.getLocalTargetAssessments('src')).map((a) => [a.resolvedTarget, a.status]),
    );
    expect(status['assets/report.pdf']).toBe('exact');
    expect(status['assets/logo.png']).toBe('exact');
    expect(status['assets/missing.pdf']).toBe('missing');
  });
});
