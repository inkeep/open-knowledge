import { describe, expect, test } from 'bun:test';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { sharedExtensions } from '../extensions/shared';
import { buildMediaJsxNodeData } from './index.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

interface JsxNode {
  type: 'jsxComponent';
  attrs: {
    componentName: string;
    kind: 'element';
    attributes: never[];
    sourceRaw?: string;
    sourceDirty?: boolean;
    props: Record<string, unknown>;
  };
}

function findJsxNode(
  json: { type?: string; content?: unknown[]; attrs?: { componentName?: string } },
  componentName: string,
): JsxNode | undefined {
  if (json.type === 'jsxComponent' && json.attrs?.componentName === componentName) {
    return json as JsxNode;
  }
  if (Array.isArray(json.content)) {
    for (const child of json.content) {
      const found = findJsxNode(
        child as { type?: string; content?: unknown[]; attrs?: { componentName?: string } },
        componentName,
      );
      if (found) return found;
    }
  }
  return undefined;
}

function wrapInDoc(node: ReturnType<typeof buildMediaJsxNodeData>) {
  return {
    type: 'doc',
    content: [node],
  };
}

describe('media drop-shape ≡ parser-shape invariant', () => {
  test('jsx-img drop shape round-trips through serialize → parse with identical props', () => {
    const dropped = buildMediaJsxNodeData('jsx-img', '/photo.png');
    expect(dropped.attrs.componentName).toBe('img');
    expect(dropped.attrs.props).toEqual({ src: '/photo.png' });

    const md = mdManager.serialize(wrapInDoc(dropped));
    expect(md).toContain('<img');
    expect(md).toContain('src="/photo.png"');
    expect(md).not.toContain('alt=');

    const reparsed = mdManager.parse(md);
    const node = findJsxNode(reparsed, 'img');
    expect(node).toBeDefined();
    expect(node?.attrs.componentName).toBe('img');
    expect(node?.attrs.props).toEqual(dropped.attrs.props);
  });

  test('jsx-video drop shape round-trips through serialize → parse', () => {
    const dropped = buildMediaJsxNodeData('jsx-video', '/clip.mp4');
    expect(dropped.attrs.componentName).toBe('video');
    expect(dropped.attrs.props).toEqual({ src: '/clip.mp4', controls: true });

    const md = mdManager.serialize(wrapInDoc(dropped));
    expect(md).toContain('<video');
    expect(md).toContain('src="/clip.mp4"');
    expect(md).not.toMatch(/controls(=|\s|\/>|>)/);

    const reparsed = mdManager.parse(md);
    const node = findJsxNode(reparsed, 'video');
    expect(node).toBeDefined();
    expect(node?.attrs.componentName).toBe('video');
    expect(node?.attrs.props).toEqual({ src: '/clip.mp4' });
  });

  test('jsx-audio drop shape round-trips through serialize → parse', () => {
    const dropped = buildMediaJsxNodeData('jsx-audio', '/song.mp3');
    expect(dropped.attrs.componentName).toBe('audio');
    expect(dropped.attrs.props).toEqual({ src: '/song.mp3', controls: true });

    const md = mdManager.serialize(wrapInDoc(dropped));
    expect(md).toContain('<audio');
    expect(md).toContain('src="/song.mp3"');
    expect(md).not.toMatch(/controls(=|\s|\/>|>)/);

    const reparsed = mdManager.parse(md);
    const node = findJsxNode(reparsed, 'audio');
    expect(node).toBeDefined();
    expect(node?.attrs.componentName).toBe('audio');
    expect(node?.attrs.props).toEqual({ src: '/song.mp3' });
  });
});
