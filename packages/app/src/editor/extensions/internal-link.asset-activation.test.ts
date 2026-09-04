import { classifyMarkdownHref } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { resolveLinkMarkAssetActivation } from './internal-link';

const DOC = 'notes/readme';

function activate(href: string, sourceForm: unknown) {
  return resolveLinkMarkAssetActivation({
    href,
    sourceForm,
    docName: DOC,
    classified: classifyMarkdownHref(href, DOC),
  });
}

describe('resolveLinkMarkAssetActivation', () => {
  test('a wikiembed mark keeps its percent sequences literal', () => {
    expect(activate('/media/100%20done.png', 'wikiembed')).toEqual({
      kind: 'asset',
      url: '/media/100%20done.png',
      ext: 'png',
      literal: true,
      projectRelPath: 'media/100%20done.png',
    });
  });

  test('a wikiembed mark does not resolve to its decoded neighbour', () => {
    const activation = activate('/media/100%20done.png', 'wikiembed');
    expect(activation.kind).toBe('asset');
    if (activation.kind !== 'asset') return;
    expect(activation.projectRelPath).not.toBe('media/100 done.png');
    expect(activation.literal).toBe(true);
  });

  test('the same bytes on a markdown mark DO decode', () => {
    expect(activate('./media/100%20done.png', undefined)).toEqual({
      kind: 'asset',
      url: './media/100%20done.png',
      ext: 'png',
      literal: false,
      projectRelPath: 'notes/media/100 done.png',
    });
  });

  test('a bare wiki target with no leading slash stays literal', () => {
    const activation = activate('100%20done.png', 'wikiembed');
    expect(activation.kind).toBe('asset');
    if (activation.kind !== 'asset') return;
    expect(activation.projectRelPath).toBe('notes/100%20done.png');
    expect(activation.projectRelPath).not.toBe('notes/100 done.png');
  });

  test('a doc link is not an asset activation', () => {
    expect(activate('./other.md', undefined)).toEqual({ kind: 'not-asset' });
    expect(activate('https://example.com', undefined)).toEqual({ kind: 'not-asset' });
  });

  test('a path-escaping asset href is refused rather than dispatched', () => {
    expect(activate('../../../etc/passwd.png', undefined)).toEqual({ kind: 'refused' });
  });
});
