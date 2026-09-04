import { MarkdownManager, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { cleanup } from '@testing-library/react';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';

const mdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
  cleanup();
});

function mount(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({ element: container, extensions: sharedExtensions, editable: true });
  const entry = { editor, container };
  mounted.push(entry);
  return entry;
}

function visibleText(root: HTMLElement): string {
  let out = '';
  const walk = (node: ChildNode): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (
      node.style.display === 'none' ||
      node.style.visibility === 'hidden' ||
      node.hasAttribute('hidden')
    )
      return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

function renderedAttrs(spec: unknown): Record<string, unknown> | null {
  if (!Array.isArray(spec)) return null;
  const attrs = spec[1];
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return null;
  return attrs as Record<string, unknown>;
}

const HIDING_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;

describe('no editor mark or node hides its own content', () => {
  const schema = getSchema(sharedExtensions);

  test('no mark renders a hiding inline style', () => {
    const offenders: string[] = [];
    for (const markType of Object.values(schema.marks)) {
      let attrs: Record<string, unknown> | null = null;
      try {
        attrs = renderedAttrs(markType.spec.toDOM?.(markType.create(), true));
      } catch {
        continue;
      }
      const style = attrs?.style;
      if (typeof style === 'string' && HIDING_STYLE.test(style)) offenders.push(markType.name);
    }
    expect(offenders).toEqual([]);
  });

  test('no node renders a hiding inline style', () => {
    const offenders: string[] = [];
    for (const nodeType of Object.values(schema.nodes)) {
      let attrs: Record<string, unknown> | null = null;
      try {
        const node = nodeType.createAndFill();
        if (!node) continue;
        attrs = renderedAttrs(nodeType.spec.toDOM?.(node));
      } catch {
        continue;
      }
      const style = attrs?.style;
      if (typeof style === 'string' && HIDING_STYLE.test(style)) offenders.push(nodeType.name);
    }
    expect(offenders).toEqual([]);
  });
});

describe('promoters that keep their claimed run as text keep it visible', () => {
  const CASES = [
    { promoter: 'comment (percent)', typed: 'before %%mid%% after', visible: 'mid' },
    { promoter: 'comment (html)', typed: 'before <!-- mid --> after', visible: 'mid' },
    { promoter: 'wiki link', typed: '[[note]]', visible: 'note' },
    { promoter: 'autolink (scheme)', typed: 'see https://example.com now', visible: 'example.com' },
    { promoter: 'autolink (www)', typed: 'see www.example.com now', visible: 'example.com' },
    { promoter: 'autolink (email)', typed: 'mail a@example.com now', visible: 'a@example.com' },
    { promoter: 'autolink (angle)', typed: '<https://example.com>', visible: 'example.com' },
    { promoter: 'tag', typed: 'see #roadmap for more', visible: 'roadmap' },
    { promoter: 'highlight (html)', typed: 'a <mark>x</mark> b', visible: 'x' },
    { promoter: 'highlight (equals)', typed: 'a ==hi== b', visible: 'hi' },
    { promoter: 'inline code', typed: 'call `run` now', visible: 'run' },
    { promoter: 'link', typed: '[label](https://example.com)', visible: 'label' },
    { promoter: 'task item', typed: '- [ ] todo', visible: 'todo' },
  ] as const;

  for (const { promoter, typed, visible } of CASES) {
    test(`${promoter}: "${typed}" still shows "${visible}" after re-derivation`, () => {
      const { editor, container } = mount();
      editor.view.dispatch(editor.state.tr.insertText(typed));

      const bytes = mdManager.serialize(editor.getJSON());
      const next: JSONContent = mdManager.parseWithFallback(stripFrontmatter(bytes).body);
      editor.commands.setContent(next);

      expect(visibleText(container)).toContain(visible);
    });
  }
});
