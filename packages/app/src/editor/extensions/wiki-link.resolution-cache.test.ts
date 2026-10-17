import * as wikiLinkResolve from '@inkeep/open-knowledge-core/utils/wiki-link-resolve';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as linkTargetIntent from '../../components/link-target-intent';
import {
  resetLinkValidationPolicyForTest,
  setLinkValidationVisible,
} from '../link-validation-policy';
import {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  type PageListCacheSnapshot,
} from '../page-list-cache';
import { getWikiLinkResolutionState } from './wiki-link';
import { toWikiLinkSlug } from './wiki-link-helpers';

function snapshot(names: string[]): PageListCacheSnapshot {
  const pages = new Set(names);
  return {
    pages,
    folderPaths: new Set(),
    pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
  };
}

beforeEach(() => resetLinkValidationPolicyForTest());

afterEach(() => {
  vi.restoreAllMocks();
  resetLinkValidationPolicyForTest();
});

describe('wiki-link resolution reuse', () => {
  test('repeated targets in one namespace are resolved once', () => {
    const resolve = vi.spyOn(wikiLinkResolve, 'resolveWikiLinkTarget');
    const intent = vi.spyOn(linkTargetIntent, 'resolveLinkTargetIntent');
    const cache = snapshot(['note']);
    for (let i = 0; i < 4; i++) {
      expect(getWikiLinkResolutionState('note', null, cache)).toBe('resolved');
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(intent).toHaveBeenCalledTimes(1);
  });

  test('a new namespace cannot reuse the previous namespace’s answer', () => {
    expect(getWikiLinkResolutionState('note', null, snapshot([]))).toBe('unresolved');
    expect(getWikiLinkResolutionState('note', null, snapshot(['note']))).toBe('resolved');
  });

  test('validation visibility is part of the resolution context', () => {
    const cache = snapshot([]);
    expect(getWikiLinkResolutionState('missing', null, cache)).toBe('unresolved');
    setLinkValidationVisible(false);
    expect(getWikiLinkResolutionState('missing', null, cache)).toBeNull();
    setLinkValidationVisible(true);
    expect(getWikiLinkResolutionState('missing', null, cache)).toBe('unresolved');
  });

  test('links with different anchors retain their resolution state', () => {
    const cache = snapshot(['note']);
    expect(getWikiLinkResolutionState('note', 'one', cache)).toBe('resolved');
    expect(getWikiLinkResolutionState('note', 'two', cache)).toBe('resolved');
  });

  test('resolution reuse remains bounded', () => {
    const resolve = vi.spyOn(wikiLinkResolve, 'resolveWikiLinkTarget');
    const cache = snapshot(['note']);
    expect(getWikiLinkResolutionState('note', null, cache)).toBe('resolved');
    for (let i = 0; i < 512; i++) getWikiLinkResolutionState(`missing-${i}`, null, cache);
    expect(getWikiLinkResolutionState('note', null, cache)).toBe('resolved');
    expect(resolve).toHaveBeenCalledTimes(514);
  });
});
