import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { DiskEvent, WatcherHandle } from './file-watcher.ts';
import { getLogger } from './logger.ts';
import { reconcileRecoveredFileTarget } from './recovered-file-target.ts';

describe('reconcileRecoveredFileTarget', () => {
  test('evicts the file index and referenced-asset cache after a recovered delete', () => {
    const mutations: DiskEvent[] = [];
    const invalidateReferencedAssetsCache = vi.fn();
    const contentDir = '/project';

    reconcileRecoveredFileTarget({
      watcher: {
        mutateFileIndex: (event) => mutations.push(event),
      } satisfies Pick<WatcherHandle, 'mutateFileIndex'>,
      contentDir,
      relativePath: 'assets/report.pdf',
      exists: false,
      invalidateReferencedAssetsCache,
    });

    expect(mutations).toEqual([
      {
        kind: 'file-delete',
        path: join(contentDir, 'assets/report.pdf'),
        relativePath: 'assets/report.pdf',
      },
    ]);
    expect(invalidateReferencedAssetsCache).toHaveBeenCalledOnce();
  });

  test('warns when recovered file metadata fails for a reason other than disappearance', () => {
    const warnSpy = vi.spyOn(getLogger('recovered-file-target'), 'warn');
    const mutations: DiskEvent[] = [];
    const relativePath = 'a'.repeat(5_000);

    reconcileRecoveredFileTarget({
      watcher: {
        mutateFileIndex: (event) => mutations.push(event),
      } satisfies Pick<WatcherHandle, 'mutateFileIndex'>,
      contentDir: '/',
      relativePath,
      exists: true,
      invalidateReferencedAssetsCache: null,
    });

    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ kind: 'file-delete', relativePath });
    expect(warnSpy).toHaveBeenCalledWith(
      { code: 'ENAMETOOLONG' },
      'recovered file metadata unavailable; treating local target as deleted',
    );
  });

  test('restores a recovered file with its canonical metadata', () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-recovered-file-target-'));
    try {
      const relativePath = 'assets/report.pdf';
      mkdirSync(join(contentDir, 'assets'));
      const targetPath = join(contentDir, relativePath);
      writeFileSync(targetPath, 'report');
      const canonicalPath = realpathSync(targetPath);
      const stats = statSync(canonicalPath);
      const mutations: DiskEvent[] = [];
      const invalidateReferencedAssetsCache = vi.fn();

      reconcileRecoveredFileTarget({
        watcher: {
          mutateFileIndex: (event) => mutations.push(event),
        } satisfies Pick<WatcherHandle, 'mutateFileIndex'>,
        contentDir,
        relativePath,
        exists: true,
        invalidateReferencedAssetsCache,
      });

      expect(mutations).toEqual([
        {
          kind: 'file-create',
          path: canonicalPath,
          relativePath,
          size: stats.size,
          modifiedTs: stats.mtimeMs,
          inode: stats.ino,
        },
      ]);
      expect(invalidateReferencedAssetsCache).toHaveBeenCalledOnce();
    } finally {
      rmSync(contentDir, { recursive: true, force: true });
    }
  });
});
