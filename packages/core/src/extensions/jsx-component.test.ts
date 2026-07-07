/**
 * Tests for jsxComponent PM node — native MDX form.
 *
 * The old code-fence form (```jsx-component) is replaced by native MDX via remark-mdx.
 * These tests verify the jsxComponent PM node works correctly with the new pipeline.
 */
import { describe, expect, test } from 'bun:test';
import { type Extension, getSchema, type Mark, type Node } from '@tiptap/core';
import { MarkdownManager } from '../markdown/index.ts';
import { sharedExtensions } from './shared';

type TiptapExtensionLike = Extension | Node | Mark;

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

describe('jsxComponent schema', () => {
  test('jsxComponent node exists in schema', () => {
    expect(schema.nodes.jsxComponent).toBeDefined();
  });

  test('jsxComponent is a non-atom block node with block* content', () => {
    expect(schema.nodes.jsxComponent.spec.atom).toBeFalsy();
    expect(schema.nodes.jsxComponent.spec.content).toBe('block*');
    expect(schema.nodes.jsxComponent.spec.isolating).toBe(true);
    expect(schema.nodes.jsxComponent.spec.defining).toBe(true);
  });

  test('jsxComponent has sourceRaw attribute for γ pristine path', () => {
    expect(schema.nodes.jsxComponent.spec.attrs?.sourceRaw).toBeDefined();
  });
});

describe('jsxComponent via native MDX', () => {
  test('self-closing MDX component stores raw source in sourceRaw', () => {
    const md = '<Button variant="primary" />\n';
    const json = mdManager.parse(md);
    const jsxNode = json.content?.find((n) => n.type === 'jsxComponent');
    expect(jsxNode).toBeDefined();
    expect(jsxNode?.attrs.sourceRaw).toContain('Button');
  });

  test('self-closing MDX component round-trips', () => {
    const md = '<Button variant="primary" />\n';
    const result = mdManager.serialize(mdManager.parse(md));
    expect(result.trim()).toBe(md.trim());
  });

  test('MDX component with expression attr round-trips', () => {
    const md = '<Chart data={items} />\n';
    const result = mdManager.serialize(mdManager.parse(md));
    expect(result.trim()).toBe(md.trim());
  });

  test('MDX component with member expression round-trips', () => {
    const md = '<Docs.Link href="/api" />\n';
    const result = mdManager.serialize(mdManager.parse(md));
    expect(result.trim()).toBe(md.trim());
  });
});

describe('jsxComponent insertJsxComponent command', () => {
  test('command is available in extension', () => {
    // The insertJsxComponent command is defined in JsxComponent extension
    const ext = sharedExtensions.find((e: TiptapExtensionLike) => {
      if (e.name === 'jsxComponent') return true;
      const config = (e as { config?: { name?: string } }).config;
      return config?.name === 'jsxComponent';
    });
    expect(ext).toBeDefined();
  });
});
