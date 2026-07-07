/**
 * WikiLinkEmbed TipTap Node — renderHTML / parseHTML coverage.
 *
 * The clipboard-round-trip is the load-bearing invariant: a user copies
 * the rendered embed from one doc (DOM `<img data-wiki-embed ...>` or
 * `<a data-wiki-embed ...>`) and pastes it into another. Without
 * parseHTML matching both tag shapes at `priority: 100`, standard Image
 * / Link extensions (priority 50) would claim the node first, the
 * `sourceForm='wikiembed'` marker would be lost, and the next save
 * would serialize as plain markdown `![](...)` / `[](...)` instead of
 * `![[...]]`.
 *
 * Tests also guard the schema-add-only invariant (precedent #9): if a
 * future change narrows the parseHTML matchers or drops an attr,
 * round-trip regresses silently for every existing embed in every
 * vault. A dedicated unit test fails loud.
 *
 * Approach: introspect the PM schema that getSchema(sharedExtensions)
 * builds. `nodeType.spec.toDOM` is the compiled renderHTML (returns a
 * DOMOutputSpec tuple); `nodeType.spec.parseDOM` is the compiled
 * parseHTML (array of tag-matcher rules with getAttrs). Avoids
 * requiring a DOM runtime (Bun's test env has no `window`).
 */
import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { sharedExtensions } from './shared';

const schema = getSchema(sharedExtensions);
const nodeType = schema.nodes.wikiLinkEmbed;

function createEmbed(
  target: string,
  attrs: Partial<{ alias: string | null; anchor: string | null; resolvedSrc: string | null }> = {},
): PmNode {
  return nodeType.create({
    target,
    alias: attrs.alias ?? null,
    anchor: attrs.anchor ?? null,
    resolvedSrc: attrs.resolvedSrc ?? null,
  });
}

interface RenderTuple {
  tag: string;
  attrs: Record<string, string>;
  label: string | null;
}

function render(node: PmNode): RenderTuple {
  const toDOM = nodeType.spec.toDOM;
  if (typeof toDOM !== 'function') {
    throw new Error('wikiLinkEmbed spec has no toDOM');
  }
  const spec = toDOM(node);
  if (!Array.isArray(spec)) {
    throw new Error('toDOM returned non-array DOMOutputSpec');
  }
  const tag = spec[0];
  const attrs = spec[1];
  const label = spec[2];
  if (typeof tag !== 'string') throw new Error('toDOM tag must be a string');
  return {
    tag,
    attrs: attrs && typeof attrs === 'object' ? (attrs as Record<string, string>) : {},
    label: typeof label === 'string' ? label : null,
  };
}

describe('WikiLinkEmbed.renderHTML — image extension', () => {
  test('emits <img> with data-* attrs + target as src', () => {
    const out = render(createEmbed('photo.png'));
    expect(out.tag).toBe('img');
    expect(out.attrs['data-wiki-embed']).toBe('');
    expect(out.attrs['data-target']).toBe('photo.png');
    expect(out.attrs['data-alias']).toBe('');
    expect(out.attrs['data-anchor']).toBe('');
    expect(out.attrs.src).toBe('photo.png');
    expect(out.attrs.alt).toBe('photo.png');
  });

  test('honors resolvedSrc over bare target', () => {
    const out = render(createEmbed('photo.png', { resolvedSrc: 'attachments/photo.png' }));
    expect(out.attrs.src).toBe('attachments/photo.png');
    // data-target stays the bare basename — round-trip through markdown
    // must preserve the author's `![[photo.png]]` shape, not the
    // resolver's output.
    expect(out.attrs['data-target']).toBe('photo.png');
  });

  test('uses alias as alt when provided', () => {
    const out = render(createEmbed('diagram.svg', { alias: 'architecture diagram' }));
    expect(out.attrs.alt).toBe('architecture diagram');
    expect(out.attrs['data-alias']).toBe('architecture diagram');
  });

  test('image extensions covered: png / jpg / jpeg / gif / webp / avif / svg', () => {
    const exts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'];
    for (const ext of exts) {
      const out = render(createEmbed(`asset.${ext}`));
      expect(out.tag).toBe('img');
    }
  });
});

describe('WikiLinkEmbed.renderHTML — non-image extension', () => {
  test('emits <a> with label + target href', () => {
    const out = render(createEmbed('draft.pdf'));
    expect(out.tag).toBe('a');
    expect(out.attrs['data-wiki-embed']).toBe('');
    expect(out.attrs['data-target']).toBe('draft.pdf');
    expect(out.attrs.href).toBe('draft.pdf');
    expect(out.label).toBe('draft.pdf');
  });

  test('anchor composes into href as #anchor suffix', () => {
    const out = render(createEmbed('draft.pdf', { anchor: 'page=3' }));
    expect(out.attrs.href).toBe('draft.pdf#page=3');
    // Label uses target#anchor when no alias.
    expect(out.label).toBe('draft.pdf#page=3');
  });

  test('alias overrides the link label', () => {
    const out = render(createEmbed('sound.mp3', { alias: 'Opening theme' }));
    expect(out.label).toBe('Opening theme');
  });

  test('resolvedSrc overrides href for non-image fallback too', () => {
    const out = render(
      createEmbed('draft.pdf', { resolvedSrc: 'attachments/draft.pdf', anchor: 'page=3' }),
    );
    // resolvedSrc wins as the href base; anchor still composes on top.
    expect(out.attrs.href).toBe('attachments/draft.pdf#page=3');
  });

  test('non-image extensions covered: pdf / mp4 / mp3 / zip / docx', () => {
    const exts = ['pdf', 'mp4', 'mp3', 'zip', 'docx'];
    for (const ext of exts) {
      const out = render(createEmbed(`asset.${ext}`));
      expect(out.tag).toBe('a');
    }
  });
});

describe('WikiLinkEmbed.parseHTML — clipboard round-trip', () => {
  test('parseDOM matchers cover both <img> and <a> shapes at priority 100', () => {
    const rules = nodeType.spec.parseDOM ?? [];
    expect(rules).toHaveLength(2);
    const tags = rules.map((rule) => rule.tag);
    expect(tags).toContain('img[data-wiki-embed]');
    expect(tags).toContain('a[data-wiki-embed]');
    // Priority 100 is load-bearing: standard Image / Link extensions
    // default to 50 and would otherwise claim the node first, losing
    // the sourceForm=wikiembed marker on paste.
    for (const rule of rules) expect(rule.priority).toBe(100);
  });

  test('getAttrs reads data-* attrs off a matching <img>', () => {
    const rules = nodeType.spec.parseDOM ?? [];
    const imgRule = rules.find((rule) => rule.tag === 'img[data-wiki-embed]');
    if (!imgRule?.getAttrs) throw new Error('img[data-wiki-embed] matcher missing');

    const fakeImg = {
      hasAttribute: (name: string) => name === 'data-wiki-embed',
      getAttribute: (name: string) => {
        if (name === 'data-target') return 'photo.png';
        if (name === 'data-alias') return '';
        if (name === 'data-anchor') return '';
        return null;
      },
    } as unknown as HTMLElement;

    const attrs = imgRule.getAttrs(fakeImg);
    expect(attrs).not.toBe(false);
    expect(attrs).toMatchObject({ target: 'photo.png', alias: null, anchor: null });
  });

  test('getAttrs returns false on <img> WITHOUT data-wiki-embed', () => {
    const rules = nodeType.spec.parseDOM ?? [];
    const imgRule = rules.find((rule) => rule.tag === 'img[data-wiki-embed]');
    if (!imgRule?.getAttrs) throw new Error('img[data-wiki-embed] matcher missing');

    const fakeImg = {
      hasAttribute: () => false,
      getAttribute: () => null,
    } as unknown as HTMLElement;

    expect(imgRule.getAttrs(fakeImg)).toBe(false);
  });
});

describe('WikiLinkEmbed schema invariants (precedent #9)', () => {
  test('wikiLinkEmbed node exists in schema', () => {
    expect(nodeType).toBeDefined();
  });

  test('required attrs exist with defaults', () => {
    const attrs = nodeType.spec.attrs ?? {};
    expect(attrs.target).toBeDefined();
    expect(attrs.alias).toBeDefined();
    expect(attrs.anchor).toBeDefined();
    expect(attrs.resolvedSrc).toBeDefined();
    // All must have defaults so y-prosemirror can reconstruct the node
    // when the schema adds new attrs post-document-creation.
    for (const [, attrSpec] of Object.entries(attrs)) {
      expect('default' in (attrSpec as Record<string, unknown>)).toBe(true);
    }
  });

  test('group/inline/atom stay stable', () => {
    const spec = nodeType.spec;
    expect(spec.group).toBe('inline');
    expect(spec.inline).toBe(true);
    expect(spec.atom).toBe(true);
  });
});
