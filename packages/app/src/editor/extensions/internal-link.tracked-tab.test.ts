import { createTargetNamespace } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { assetPathFromHash, hashFromAssetPath } from '@/lib/doc-hash';
import { assetTabId, filterOpenTabsForKnownTargets } from '../editor-tabs';
import { activateAssetLink } from '../internal-link-helpers';
import type { PageListCacheSnapshot } from '../page-list-cache';
import { resolveStoredAssetActivation, resolveTrackedFileActivation } from './internal-link';

const DOC = 'notes/readme';
const CAFE_NFC = 'Café'.normalize('NFC');
const CAFE_NFD = 'Café'.normalize('NFD');

function snapshot(
  assetPaths: readonly string[],
  filePaths: readonly string[],
): PageListCacheSnapshot {
  return {
    pages: createTargetNamespace('document', [DOC]),
    folderPaths: createTargetNamespace('folder', ['notes']),
    assetPaths: createTargetNamespace('file', assetPaths),
    filePaths: createTargetNamespace('file', filePaths),
    pagesBySlug: new Map(),
  };
}

function tabOpenedBy(activation: {
  url: string;
  projectRelPath: string;
  ext: string;
  title: string;
}) {
  let navigatedTo: string | null = null;
  activateAssetLink(
    { ...activation, newTab: false },
    {
      navigate: (assetPath) => {
        navigatedTo = assetPath;
      },
    },
  );
  const assetPath = navigatedTo === null ? null : assetPathFromHash(hashFromAssetPath(navigatedTo));
  return assetPath === null ? null : assetTabId(assetPath);
}

function survivesRefresh(tabId: string, cache: PageListCacheSnapshot): boolean {
  return (
    filterOpenTabsForKnownTargets([tabId], {
      pages: cache.pages,
      folderPaths: cache.folderPaths,
      assetPaths: cache.assetPaths ?? new Set(),
      filePaths: cache.filePaths,
    }).length === 1
  );
}

describe('a tab opened from a differently spelled link to a tracked file', () => {
  test.each([
    ['letter case', './notice', 'notes/NOTICE'],
    ['normalization form', `./${CAFE_NFC}`, `notes/${CAFE_NFD}`],
  ])(
    'opens under the stored spelling and survives a page-list refresh (%s)',
    (_label, href, stored) => {
      const cache = snapshot([], [stored]);
      const activation = resolveTrackedFileActivation(href, DOC, cache);
      expect(activation?.projectRelPath).toBe(stored);
      expect(activation?.title).toBe(stored.split('/').pop());
      const tabId = activation === null ? null : tabOpenedBy(activation);
      expect(tabId).toBe(assetTabId(stored));
      expect(tabId !== null && survivesRefresh(tabId, cache)).toBe(true);
    },
  );
});

describe('a tab opened from a differently spelled asset link', () => {
  test.each([
    ['letter case', './Photo.PNG', 'notes/photo.png'],
    ['normalization form', `./${CAFE_NFC}.png`, `notes/${CAFE_NFD}.png`],
  ])(
    'opens under the stored spelling and survives a page-list refresh (%s)',
    (_label, href, stored) => {
      const cache = snapshot([stored], []);
      const activation = resolveStoredAssetActivation(
        { url: href, ext: 'png', literal: false, projectRelPath: `notes/${href.slice(2)}` },
        DOC,
        cache,
      );
      expect(activation?.projectRelPath).toBe(stored);
      const tabId = activation === null ? null : tabOpenedBy(activation);
      expect(tabId).toBe(assetTabId(stored));
      expect(tabId !== null && survivesRefresh(tabId, cache)).toBe(true);
    },
  );

  test('a link naming no tracked file opens nothing', () => {
    expect(
      resolveStoredAssetActivation(
        { url: './ghost.png', ext: 'png', literal: false, projectRelPath: 'notes/ghost.png' },
        DOC,
        snapshot(['notes/photo.png'], []),
      ),
    ).toBeNull();
  });
});

describe('the known-target sync keeps tabs whose spelling is identity-equal to a known target', () => {
  test('asset and file tabs match by the file identity rule', () => {
    const cache = snapshot(['notes/photo.png'], [`notes/${CAFE_NFD}`]);
    expect(survivesRefresh(assetTabId('notes/PHOTO.png'), cache)).toBe(true);
    expect(survivesRefresh(assetTabId(`notes/${CAFE_NFC}`), cache)).toBe(true);
    expect(survivesRefresh(assetTabId('Notes/photo.png'), cache)).toBe(false);
    expect(survivesRefresh(assetTabId('notes/gone.png'), cache)).toBe(false);
  });
});
