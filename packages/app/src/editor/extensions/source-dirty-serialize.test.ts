import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'vitest';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

function findNode(node: JSONContent, type: string): JSONContent | undefined {
  if (node.type === type) return node;
  if (node.content) {
    for (const child of node.content) {
      const found = findNode(child, type);
      if (found) return found;
    }
  }
  return undefined;
}

function findAllNodes(node: JSONContent, type: string): JSONContent[] {
  const results: JSONContent[] = [];
  if (node.type === type) results.push(node);
  if (node.content) {
    for (const child of node.content) {
      results.push(...findAllNodes(child, type));
    }
  }
  return results;
}

function normalize(s: string): string {
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n+$/, '');
}

describe('DT — Dirty-tracking serialization behavior', () => {
  test('DT08: pristine Callout emits byte-identical sourceRaw on save', () => {
    const input = '<Callout type="warning">\n\nAlways run tests\n\n</Callout>\n';
    const json = mdManager.parse(input);
    const component = findNode(json, 'jsxComponent');
    expect(component?.attrs?.sourceDirty).toBe(false);
    expect(component?.attrs?.sourceRaw).toBeTruthy();

    const output = mdManager.serialize(json);
    expect(normalize(output)).toBe(normalize(input));
  });

  test('DT09: dirty Callout serializes via reconstruction path', () => {
    const input = '<Callout type="warning">\n\nAlways run tests\n\n</Callout>\n';
    const json = mdManager.parse(input);
    const component = findNode(json, 'jsxComponent');

    if (component?.attrs) component.attrs.sourceDirty = true;

    const output = mdManager.serialize(json);
    expect(output).toContain('Callout');
    expect(output).toContain('Always run tests');
    expect(output).toContain('type="warning"');

    const reparsed = mdManager.parse(output);
    const reoutput = mdManager.serialize(reparsed);
    expect(normalize(reoutput)).toBe(normalize(output));
  });

  test('DT-nested-01: pristine parent + pristine child → sourceRaw (byte-identical)', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    const components = findAllNodes(json, 'jsxComponent');
    for (const c of components) {
      expect(c.attrs?.sourceDirty).toBe(false);
    }

    const output = mdManager.serialize(json);
    expect(normalize(output)).toBe(normalize(input));
  });

  test('DT-nested-02: pristine parent + dirty child → parent forced to reconstruct', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    const stepsComponents = findAllNodes(json, 'jsxComponent');
    const stepB = stepsComponents[2];
    expect(stepB).toBeDefined();
    if (stepB?.attrs) stepB.attrs.sourceDirty = true;

    const stepBParagraph = stepB?.content?.[0];
    if (stepBParagraph?.content?.[0]) {
      stepBParagraph.content[0].text = 'B-new';
    }

    const output = mdManager.serialize(json);
    expect(output).toContain('B-new');
    expect(output).toContain('A');
    expect(output).toContain('Steps');
  });

  test('DT-nested-03: dirty parent + pristine child → parent reconstructs, children use sourceRaw', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    const stepsComponents = findAllNodes(json, 'jsxComponent');
    if (stepsComponents[0]?.attrs) stepsComponents[0].attrs.sourceDirty = true;

    const output = mdManager.serialize(json);
    expect(output).toContain('Steps');
    expect(output).toContain('A');
    expect(output).toContain('B');
  });

  test('DT-nested-04: both dirty → both reconstruct', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    const stepsComponents = findAllNodes(json, 'jsxComponent');
    for (const c of stepsComponents) {
      if (c.attrs) c.attrs.sourceDirty = true;
    }

    const output = mdManager.serialize(json);
    expect(output).toContain('Steps');
    expect(output).toContain('A');
    expect(output).toContain('B');

    const reparsed = mdManager.parse(output);
    const reoutput = mdManager.serialize(reparsed);
    expect(normalize(reoutput)).toBe(normalize(output));
  });

  test('DT-nested-05: depth-independence — dirty great-grandchild propagates', () => {
    const input =
      '<Tabs items={["a","b"]}>\n\n<Tab value="a">\n\n<Steps>\n\n<Step>\n\nDeep content\n\n</Step>\n\n</Steps>\n\n</Tab>\n\n</Tabs>\n';
    const json = mdManager.parse(input);

    const allComponents = findAllNodes(json, 'jsxComponent');
    const deepest = allComponents[allComponents.length - 1];
    if (deepest?.attrs) deepest.attrs.sourceDirty = true;

    const output = mdManager.serialize(json);
    expect(output).toContain('Deep content');
    expect(output).toContain('Tabs');
    expect(output).toContain('Steps');
    expect(output).toContain('Step');
  });

  test('DT12: byte-identity corpus — parse then serialize without editing → no byte changes', () => {
    const corpus = [
      '# Hello\n\nParagraph\n',
      '<Callout type="info">\n\nContent\n\n</Callout>\n',
      '<Card href="/docs">\n\nCard text\n\n</Card>\n',
      'Text with <Icon name="check" /> inline\n',
      '**bold** and _italic_\n',
      '```js\nconst x = 1;\n```\n',
      '> blockquote\n',
      '- list item\n- second item\n',
    ];

    for (const input of corpus) {
      const json = mdManager.parse(input);
      const output = mdManager.serialize(json);
      expect(normalize(output)).toBe(normalize(input));
    }
  });
});

describe('DT — Expression flow passthrough', () => {
  test('Expression flow emits content verbatim', () => {
    const input = '{/* comment */}\n';
    const json = mdManager.parse(input);
    const component = findNode(json, 'jsxComponent');
    expect(component?.attrs?.kind).toBe('expression');

    const output = mdManager.serialize(json);
    expect(normalize(output)).toBe(normalize(input));
  });
});

describe('DT — Unknown attr preservation via reconstructAttrs merge (M10/FR-21)', () => {
  test('M10: unknown attrs survive γ-dirty reconstruction', () => {
    const input = '<Card color="#F05032" external>\n\nCard text\n\n</Card>\n';
    const json = mdManager.parse(input);
    const component = findNode(json, 'jsxComponent');

    if (component?.attrs) component.attrs.sourceDirty = true;

    const output = mdManager.serialize(json);
    expect(output).toContain('color="#F05032"');
    expect(output).toContain('external');
    expect(output).toContain('Card text');
  });
});
