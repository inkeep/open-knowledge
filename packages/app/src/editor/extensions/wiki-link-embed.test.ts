import { describe, expect, test } from 'vitest';
import {
  applyWikiLinkEmbedImageDomAttributes,
  resolveWikiEmbedActivation,
} from './wiki-link-embed.ts';

interface RecordingElement {
  attrs: Map<string, string>;
  setAttribute: (key: string, value: string) => void;
}

function makeElement(): RecordingElement {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (key, value) => attrs.set(key, value),
  };
}

describe('applyWikiLinkEmbedImageDomAttributes', () => {
  test('marks the React-rendered image wrapper as a non-editable wiki embed', () => {
    const dom = makeElement();
    applyWikiLinkEmbedImageDomAttributes(dom as unknown as HTMLElement, {
      nodeId: 'wle-1',
      target: 'photo.png',
      alias: null,
    });

    expect(dom.attrs.get('data-wiki-embed')).toBe('');
    expect(dom.attrs.get('data-node-id')).toBe('wle-1');
    expect(dom.attrs.get('data-target')).toBe('photo.png');
    expect(dom.attrs.get('contenteditable')).toBe('false');
  });

  test('keeps the authored alias on the outer NodeView wrapper', () => {
    const dom = makeElement();
    applyWikiLinkEmbedImageDomAttributes(dom as unknown as HTMLElement, {
      nodeId: 'wle-2',
      target: 'photo.png',
      alias: 'Team photo',
    });

    expect(dom.attrs.get('data-alias')).toBe('Team photo');
  });

  test('normalizes a missing alias to the empty data attribute', () => {
    const dom = makeElement();
    applyWikiLinkEmbedImageDomAttributes(dom as unknown as HTMLElement, {
      nodeId: 'wle-3',
      target: 'photo.png',
      alias: null,
    });

    expect(dom.attrs.get('data-alias')).toBe('');
  });
});

describe('resolveWikiEmbedActivation', () => {
  test('keeps percent sequences in a bare wiki target literal', () => {
    // `![[100%20done.png]]` names a file whose name really contains `%20`, and
    // `projectRelPath` is what `shell.openPath` / `showItemInFolder` receive.
    expect(resolveWikiEmbedActivation({ target: '100%20done.png', resolvedSrc: null })).toEqual({
      url: '100%20done.png',
      projectRelPath: '100%20done.png',
      ext: 'png',
      title: '100%20done.png',
    });
  });

  test('a wiki target never resolves to its decoded neighbour', () => {
    const activation = resolveWikiEmbedActivation({ target: '100%20done.png', resolvedSrc: null });
    expect(activation?.projectRelPath).not.toBe('100 done.png');
    expect(activation?.title).not.toBe('100 done.png');
  });

  test('keeps percent sequences in a drop-time resolvedSrc literal', () => {
    // `resolvedSrc` is a filesystem path the drop pipeline produced, not a URI.
    const activation = resolveWikiEmbedActivation({
      target: '100%20done.png',
      resolvedSrc: '/media/100%20done.png',
    });
    expect(activation?.projectRelPath).toBe('media/100%20done.png');
    expect(activation?.projectRelPath).not.toBe('media/100 done.png');
  });

  test('declines a target with no extension and an empty target', () => {
    expect(resolveWikiEmbedActivation({ target: 'no-extension', resolvedSrc: null })).toBeNull();
    expect(resolveWikiEmbedActivation({ target: '', resolvedSrc: null })).toBeNull();
  });
});
