/**
 * Drop-shape ≡ parser-shape invariant for media JSX (`<img>` / `<video>` /
 * `<audio>`).
 *
 * The drop pipeline (`uploadAndInsert` in `image-upload/index.ts`) bypasses
 * the markdown parser — it inserts a PM `jsxComponent` node directly via
 * `buildMediaJsxNodeData`. The parser path emits the same node type when it
 * encounters `<img …/>` / `<video …/>` / `<audio …/>` JSX in markdown source.
 *
 * If the two shapes drift, a freshly dropped node and a reload-from-disk
 * node would carry different prop bags — same on-screen render, different
 * PM attrs — and a prop-edit on each would round-trip through different
 * code paths. This test pins both directions:
 *
 *   1. `buildMediaJsxNodeData(kind, src) → serialize → parse` produces a
 *      jsxComponent whose prop bag matches what drop emitted.
 *   2. The serialized markdown bytes are the canonical lowercase JSX form
 *      (`<img src="..." />`, `<video src="..." controls />`,
 *      `<audio src="..." controls />`).
 *
 * Note: drop intentionally omits `alt` from the `<img>` prop bag — alt is
 * required-no-default, leaving the key absent triggers the chrome-bar gear
 * nudge so the author makes an explicit alt decision (descriptive text OR
 * `alt=""` decorative opt-in per WCAG 1.1.1). Stamping `alt: ""` would
 * silently pick "decorative" on the author's behalf.
 *
 * Failure mode this guards: a parser-side default change (e.g., dropping
 * `controls` from emit when true, or stamping a synthetic `alt`) that
 * silently makes the post-roundtrip shape different from drop. Or the
 * inverse: a drop-side default change (e.g., adding `width`) that the
 * parser doesn't preserve.
 */

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

/**
 * Pull the first `jsxComponent` node out of a parsed PM doc. The dirty
 * jsxComponent emit lifts its source-form mdast into a paragraph wrapper
 * (image) or stays at block level (video / audio) depending on the parser
 * branch — so we walk the tree by type rather than indexing by position.
 */
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

/** Build a single-block PM doc JSON wrapping the dropped media node. */
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
    // Drop omits alt — author makes the decision via the chrome-bar gear
    // nudge (key-absence trips the tri-state needsConfig predicate).
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
    // Drop carries `controls: true` in its prop bag for the in-editor render
    // (Video.tsx reads it from `attrs.props`). On serialize, the canonical
    // descriptor omits `controls={true}` because `omitOnDefault: true` +
    // `defaultValue: true` collapse the explicit-default form to absent —
    // the renderer applies the true default whether the attribute is
    // present on disk or not. Parsed shape: `{src}` only.
    const dropped = buildMediaJsxNodeData('jsx-video', '/clip.mp4');
    expect(dropped.attrs.componentName).toBe('video');
    expect(dropped.attrs.props).toEqual({ src: '/clip.mp4', controls: true });

    const md = mdManager.serialize(wrapInDoc(dropped));
    expect(md).toContain('<video');
    expect(md).toContain('src="/clip.mp4"');
    // `controls={true}` matches the descriptor default — omitted from emit.
    expect(md).not.toMatch(/controls(=|\s|\/>|>)/);

    const reparsed = mdManager.parse(md);
    const node = findJsxNode(reparsed, 'video');
    expect(node).toBeDefined();
    expect(node?.attrs.componentName).toBe('video');
    expect(node?.attrs.props).toEqual({ src: '/clip.mp4' });
  });

  test('jsx-audio drop shape round-trips through serialize → parse', () => {
    // Same canonicalization as video — `controls={true}` collapses to absent.
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
