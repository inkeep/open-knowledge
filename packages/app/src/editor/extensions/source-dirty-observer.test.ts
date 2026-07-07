/**
 * Source-dirty observer origin-guard tests.
 *
 * Tests the γ pattern's dirty-tracking correctness via the MarkdownManager
 * parse/serialize round-trip. Since the source-dirty observer is a PM plugin
 * that operates inside a TipTap editor instance, and testing full editor instances
 * is done in integration tests, these tests verify the serialization behavior
 * that the dirty flag controls:
 *
 * - Pristine (sourceDirty:false) → sourceRaw emitted (byte-identical)
 * - Dirty (sourceDirty:true) → reconstruction path emitted
 * - effectiveDirty (descendant dirty) → parent reconstructs
 *
 * The actual origin-guard behavior (which PM transactions mark dirty) is
 * tested in integration/bridge-matrix tests where real editor instances
 * exist.
 */
import { describe, expect, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';

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

    // Serialize without modification → sourceRaw path
    const output = mdManager.serialize(json);
    expect(normalize(output)).toBe(normalize(input));
  });

  test('DT09: dirty Callout serializes via reconstruction path', () => {
    const input = '<Callout type="warning">\n\nAlways run tests\n\n</Callout>\n';
    const json = mdManager.parse(input);
    const component = findNode(json, 'jsxComponent');

    // Simulate dirty: set sourceDirty:true
    if (component?.attrs) component.attrs.sourceDirty = true;

    // Serialize → reconstruction path (normalization may differ from input)
    const output = mdManager.serialize(json);
    expect(output).toContain('Callout');
    expect(output).toContain('Always run tests');
    expect(output).toContain('type="warning"');

    // Verify idempotence: re-serialize should be stable (I13)
    const reparsed = mdManager.parse(output);
    const reoutput = mdManager.serialize(reparsed);
    expect(normalize(reoutput)).toBe(normalize(output));
  });

  test('DT-nested-01: pristine parent + pristine child → sourceRaw (byte-identical)', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    // All components pristine
    const components = findAllNodes(json, 'jsxComponent');
    for (const c of components) {
      expect(c.attrs?.sourceDirty).toBe(false);
    }

    // Serialize → byte-identical via sourceRaw
    const output = mdManager.serialize(json);
    expect(normalize(output)).toBe(normalize(input));
  });

  test('DT-nested-02: pristine parent + dirty child → parent forced to reconstruct', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    // Find the second Step and mark it dirty
    const stepsComponents = findAllNodes(json, 'jsxComponent');
    // stepsComponents[0] = Steps, stepsComponents[1] = Step A, stepsComponents[2] = Step B
    const stepB = stepsComponents[2];
    expect(stepB).toBeDefined();
    if (stepB?.attrs) stepB.attrs.sourceDirty = true;

    // Modify Step B's children to verify the edit is preserved
    const stepBParagraph = stepB?.content?.[0];
    if (stepBParagraph?.content?.[0]) {
      stepBParagraph.content[0].text = 'B-new';
    }

    // Serialize → parent (Steps) forced to reconstruct via effectiveDirty
    const output = mdManager.serialize(json);
    expect(output).toContain('B-new'); // Child edit preserved
    expect(output).toContain('A'); // Pristine child preserved (via recursive serialize)
    expect(output).toContain('Steps'); // Parent tag reconstructed
  });

  test('DT-nested-03: dirty parent + pristine child → parent reconstructs, children use sourceRaw', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    // Mark Steps (parent) as dirty
    const stepsComponents = findAllNodes(json, 'jsxComponent');
    if (stepsComponents[0]?.attrs) stepsComponents[0].attrs.sourceDirty = true;

    // Serialize → parent reconstructs, children emit their own sourceRaw
    const output = mdManager.serialize(json);
    expect(output).toContain('Steps');
    expect(output).toContain('A');
    expect(output).toContain('B');
  });

  test('DT-nested-04: both dirty → both reconstruct', () => {
    const input = '<Steps>\n\n<Step>\n\nA\n\n</Step>\n\n<Step>\n\nB\n\n</Step>\n\n</Steps>\n';
    const json = mdManager.parse(input);

    // Mark all as dirty
    const stepsComponents = findAllNodes(json, 'jsxComponent');
    for (const c of stepsComponents) {
      if (c.attrs) c.attrs.sourceDirty = true;
    }

    // Serialize → all reconstruct
    const output = mdManager.serialize(json);
    expect(output).toContain('Steps');
    expect(output).toContain('A');
    expect(output).toContain('B');

    // Verify idempotence (I13)
    const reparsed = mdManager.parse(output);
    const reoutput = mdManager.serialize(reparsed);
    expect(normalize(reoutput)).toBe(normalize(output));
  });

  test('DT-nested-05: depth-independence — dirty great-grandchild propagates', () => {
    const input =
      '<Tabs items={["a","b"]}>\n\n<Tab value="a">\n\n<Steps>\n\n<Step>\n\nDeep content\n\n</Step>\n\n</Steps>\n\n</Tab>\n\n</Tabs>\n';
    const json = mdManager.parse(input);

    // Find deepest jsxComponent (Step) and mark dirty
    const allComponents = findAllNodes(json, 'jsxComponent');
    const deepest = allComponents[allComponents.length - 1];
    if (deepest?.attrs) deepest.attrs.sourceDirty = true;

    // The entire ancestor chain should reconstruct via effectiveDirty propagation
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

    // Serialize → expression passthrough
    const output = mdManager.serialize(json);
    expect(normalize(output)).toBe(normalize(input));
  });
});

describe('DT — Unknown attr preservation via reconstructAttrs merge (M10/FR-21)', () => {
  test('M10: unknown attrs survive γ-dirty reconstruction', () => {
    const input = '<Card color="#F05032" external>\n\nCard text\n\n</Card>\n';
    const json = mdManager.parse(input);
    const component = findNode(json, 'jsxComponent');

    // Mark dirty to trigger reconstruction path
    if (component?.attrs) component.attrs.sourceDirty = true;

    // Serialize → reconstruction with merge semantics
    const output = mdManager.serialize(json);
    expect(output).toContain('color="#F05032"');
    expect(output).toContain('external');
    expect(output).toContain('Card text');
  });
});
