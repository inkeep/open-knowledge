import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _resetDocExtensionsForTests } from '../doc-extensions.ts';
import { createFileOpsService, type FileOpsDeps } from './file-ops.ts';

function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

function settleWithin<T>(promise: Promise<T>, label: string, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

describe('file operations while derived-index projections are queued', () => {
  let contentDir: string;

  beforeEach(() => {
    _resetDocExtensionsForTests();
    contentDir = mkdtempSync(join(tmpdir(), 'ok-file-ops-'));
  });

  afterEach(() => {
    _resetDocExtensionsForTests();
    rmSync(contentDir, { recursive: true, force: true });
  });

  function createService(overrides: Partial<FileOpsDeps> = {}) {
    const unexpected = () => {
      throw new Error('not expected in this test');
    };
    return createFileOpsService({
      contentDir,
      resolveContentEntryPath: (root, _kind, path) => join(root, path),
      docNameForPath: (relPath) => relPath.replace(/\.md$/, ''),
      docNameToRelativePath: (docName) => `${docName}.md`,
      listManagedDocNamesUnderFolder: unexpected,
      listAffectedDocNames: unexpected,
      getFileIndex: () => new Map(),
      conflictFileForDocName: () => null,
      captureAndCloseDocuments: async () => {},
      removeFolderIndexEntries: () => {},
      upsertFolderIndexPathSegments: () => {},
      deleteDerivedDocumentsBestEffort: neverSettles,
      invalidateReferencedAssetsCache: () => {},
      signalFiles: () => {},
      nextAvailableDuplicateDocName: (docName) => ({ docName: `${docName} copy` }),
      nextAvailableDuplicateFolderPath: unexpected,
      resolveDuplicateDocPath: (docName, extension) => join(contentDir, `${docName}${extension}`),
      collectMarkdownCopies: unexpected,
      collectFolderPaths: unexpected,
      recordDerivedDocumentBestEffort: neverSettles,
      recordDerivedMutationsBestEffort: neverSettles,
      ...overrides,
    });
  }

  test('trash cleanup returns without waiting for the derived delete', async () => {
    const deleteDerived = vi.fn(neverSettles);
    const service = createService({
      getFileIndex: () => new Map([['trashed', {}]]),
      deleteDerivedDocumentsBestEffort: deleteDerived,
    });

    const result = await settleWithin(
      service.trashCleanup('file', 'trashed.md', 'trashed', 'test'),
      'trashCleanup',
    );

    expect(result).toEqual({ deletedDocNames: ['trashed'] });
    expect(deleteDerived).toHaveBeenCalledExactlyOnceWith(['trashed'], 'trash-cleanup');
  });

  test('duplicating a file returns without waiting for the derived projection', async () => {
    writeFileSync(join(contentDir, 'original.md'), '# Original\n');
    const recordDerived = vi.fn(neverSettles);
    const service = createService({ recordDerivedDocumentBestEffort: recordDerived });

    const result = await settleWithin(
      service.duplicatePath('file', 'original.md', 'original'),
      'duplicatePath',
    );

    expect(result).toEqual({
      ok: true,
      duplicatedPath: 'original copy',
      duplicatedDocNames: ['original copy'],
    });
    expect(readFileSync(join(contentDir, 'original copy.md'), 'utf-8')).toBe('# Original\n');
    expect(recordDerived).toHaveBeenCalledExactlyOnceWith(
      'original copy',
      '# Original\n',
      'duplicate-path-file',
    );
  });

  test('duplicating a folder returns without waiting for the derived projection', async () => {
    mkdirSync(join(contentDir, 'archive'));
    writeFileSync(join(contentDir, 'archive', 'entry.md'), '# Entry\n');
    const recordMutations = vi.fn(neverSettles);
    const service = createService({
      listManagedDocNamesUnderFolder: () => ['archive/entry'],
      nextAvailableDuplicateFolderPath: () => ({ folderPath: 'archive copy' }),
      collectFolderPaths: (folderPath) => [folderPath],
      collectMarkdownCopies: (folderPath) => [
        {
          docName: `${folderPath}/entry`,
          fullPath: join(contentDir, folderPath, 'entry.md'),
          content: readFileSync(join(contentDir, folderPath, 'entry.md'), 'utf-8'),
        },
      ],
      recordDerivedMutationsBestEffort: recordMutations,
    });

    const result = await settleWithin(
      service.duplicatePath('folder', 'archive', 'archive'),
      'duplicatePath',
    );

    expect(result).toEqual({
      ok: true,
      duplicatedPath: 'archive copy',
      duplicatedDocNames: ['archive copy/entry'],
    });
    expect(readFileSync(join(contentDir, 'archive copy', 'entry.md'), 'utf-8')).toBe('# Entry\n');
    expect(recordMutations).toHaveBeenCalledExactlyOnceWith(
      [{ kind: 'upsert', documentName: 'archive copy/entry', markdown: '# Entry\n' }],
      'duplicate-path-folder',
    );
  });
});
