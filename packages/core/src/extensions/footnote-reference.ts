/**
 * footnoteReference — PM atom node for the inline `[^id]` reference syntax.
 *
 * Markdown source `[^1]` and `[^note]` (parsed by `remark-gfm`'s
 * mdast-util-gfm-footnote into `footnoteReference` mdast nodes) flow
 * through `index.ts`'s mdast→PM handler into this atom. Round-trip
 * relies on remark-gfm's existing footnote stringify path — the PM→mdast
 * handler emits `footnoteReference` mdast nodes that the stringifier
 * already knows how to serialize.
 *
 * Renders as a superscript link `<sup>[id]</sup>`. The body lives in a
 * separate `footnoteDefinition` block node (`extensions/footnote-
 * definition.ts`); the two are linked by the `identifier` attr.
 *
 * Footnotes were unhandled — the inline-unknown-handler
 * produced literal `"footnoteReference"` text, corrupting the document.
 * This extension closes the gap.
 */

import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnoteReference: {
      /** Insert a footnote reference with the given identifier. */
      insertFootnoteReference: (identifier: string) => ReturnType;
    };
  }
}

/**
 * Pure helper — finds the next free numeric footnote identifier given the
 * currently-known set of `footnoteDefinition` identifier strings. Existing
 * non-numeric identifiers (e.g. `[^note]`) are ignored — we only auto-
 * increment over the integer-shaped ones, matching `/footnote`'s
 * pre-existing slash-menu behavior at `slash-command/items.tsx`.
 *
 * Exported so the bubble-menu and slash-menu entry points share a single
 * "what's the next ID" definition; if the auto-numbering rule ever changes
 * (e.g. switch to letter suffixes when integers run out), both surfaces
 * pick up the new behavior from one place.
 */
export function nextFootnoteIdentifier(existingIdentifiers: readonly string[]): string {
  let maxId = 0;
  for (const id of existingIdentifiers) {
    const n = Number.parseInt(id, 10);
    if (!Number.isNaN(n) && n > maxId) maxId = n;
  }
  return String(maxId + 1);
}

/**
 * Top-level PM nodes carry both a position offset and a nodeSize — the
 * minimum subset of the PM Node API our `findFootnoteDefinitionInsertPos`
 * walker needs. Typed structurally so the helper stays pure (no
 * @tiptap/core import) and importable from the core package, while still
 * accepting real `Node` instances at call sites.
 */
export interface FootnoteWalkableDoc {
  forEach(
    f: (node: { type: { name: string }; nodeSize: number }, offset: number, index: number) => void,
  ): void;
  content: { size: number };
}

/**
 * Recursive-descent shape — the minimum subset of `PMNode.descendants`
 * `collectFootnoteIdentifiers` needs. Structural to keep the helper
 * importable from core without dragging `@tiptap/core` in.
 */
export interface FootnoteDescendableDoc {
  descendants(
    f: (
      node: { type: { name: string }; attrs: { identifier?: unknown } },
      pos: number,
    ) => boolean | undefined,
  ): void;
}

/**
 * Walk a PM doc and return every `footnoteDefinition` node's `identifier`
 * attribute, in document order. Shared between the bubble-menu and slash-
 * menu insert paths — they both feed this into `nextFootnoteIdentifier` to
 * pick the next free integer. Extracted so a future change (e.g. include
 * definitions inside compound containers via a different walker primitive)
 * lands in one place.
 */
export function collectFootnoteIdentifiers(doc: FootnoteDescendableDoc): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'footnoteDefinition') {
      ids.push(String(node.attrs.identifier ?? ''));
    }
    return true;
  });
  return ids;
}

/**
 * Pick the PM doc position to insert a fresh `footnoteDefinition` block.
 *
 * - When the doc already has at least one `footnoteDefinition`, insert
 *   IMMEDIATELY AFTER the last one — the new definition joins the existing
 *   footnote group without an empty paragraph slotted between consecutive
 *   asides.
 * - When the doc has no `footnoteDefinition` yet, append at `doc.content.size`
 *   (the end of the doc). PM's trailing-paragraph behavior will tuck a
 *   single empty `<p>` after the new definition; that one is wanted (it's
 *   the doc-end cursor-placement slot).
 *
 * Without this targeting, `insertContentAt(doc.content.size, fnDef)` repeated
 * across multiple footnotes leaves an empty `<p>` between every pair of
 * consecutive `<aside class="footnote-def">` blocks — both adding visible
 * vertical gap in WYSIWYG AND emitting redundant blank lines in the
 * serialized markdown source.
 *
 * Both the bubble-menu `Footnote` action and the slash-menu `/footnote`
 * insert through this helper so they produce identically-shaped docs.
 */
export function findFootnoteDefinitionInsertPos(doc: FootnoteWalkableDoc): number {
  let pos: number | null = null;
  doc.forEach((node, offset) => {
    if (node.type.name === 'footnoteDefinition') {
      pos = offset + node.nodeSize;
    }
  });
  return pos ?? doc.content.size;
}

export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  // Selectable so the atom behaves like other inline atoms (mathInline,
  // jsxInline). PM's selection machinery treats atomic inline nodes as
  // a single unit on click. Drag-drop matches peer atoms (default off).
  selectable: true,
  draggable: false,
  // Higher priority than StarterKit defaults so the schema registers
  // before the inline-unknown fallback path.
  priority: 60,

  addAttributes() {
    return {
      identifier: { default: '' },
      label: { default: null },
    };
  },

  parseHTML() {
    // Extract `identifier` from `data-footnote-id` (renderHTML emits it
    // there). Without `getAttrs`, TipTap looks for a DOM attribute literally
    // named `identifier`, which doesn't exist — clipboard paste would land
    // with `identifier: ''` and silently break reference→definition pairing.
    // Mirrors the wiki-link/math-inline pattern of pulling from `data-*`.
    return [
      {
        tag: 'sup[data-footnote-ref]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          const id = node.getAttribute('data-footnote-id') || '';
          return { identifier: id, label: id || null };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const id = String(node.attrs.identifier ?? '');
    return [
      'sup',
      {
        // `id="fnref-{id}"` is the back-reference target — definitions
        // render an `↩` link pointing to `#fnref-{id}`, matching the
        // Obsidian / GFM-rendered convention.
        id: `fnref-${id}`,
        'data-footnote-ref': '',
        'data-footnote-id': id,
        class: 'footnote-ref',
      },
      ['a', { href: `#fn-${id}`, class: 'footnote-ref-link' }, `[${id}]`],
    ];
  },

  addCommands() {
    return {
      insertFootnoteReference:
        (identifier) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { identifier, label: identifier },
          }),
    };
  },
});
