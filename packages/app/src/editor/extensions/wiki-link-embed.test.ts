import { describe, expect, test } from 'vitest';
import { applyWikiLinkEmbedImageDomAttributes } from './wiki-link-embed.ts';

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
