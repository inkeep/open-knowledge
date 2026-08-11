/**
 * Render valid HTML-void `<img ...>` source as an image without rewriting it.
 *
 * Core intentionally preserves the no-slash HTML form as literal text. This
 * app decoration hides only that rendered text range and inserts the same
 * target-aware image leaf used by canonical images; the ProseMirror document
 * and Y.Text keep the exact authored bytes.
 */

import { normalizeDocRelativeAssetUrl, resolveAssetProjectPath } from '@inkeep/open-knowledge-core';
import { type Editor, Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactRenderer } from '@tiptap/react';
import { BareImg, type ImageProps } from '../components/Image';

const pluginKey = new PluginKey<DecorationSet>('bareHtmlImageDecoration');

interface BareTagMatch {
  index: number;
  raw: string;
}

export interface RenderableBareHtmlImage extends BareTagMatch {
  from: number;
  to: number;
  props: ImageProps;
}

/** Find closing `>` outside quoted attributes; `alt="a > b"` stays valid. */
export function findBareHtmlImageTags(text: string): BareTagMatch[] {
  const matches: BareTagMatch[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf('<img', cursor);
    if (index === -1) break;
    const afterName = text[index + 4];
    if (afterName !== '>' && afterName !== undefined && !/\s/.test(afterName)) {
      cursor = index + 4;
      continue;
    }
    let quote: '"' | "'" | null = null;
    let end = index + 4;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      } else if (character === '<') {
        break;
      }
    }
    if (text[end] === '>') matches.push({ index, raw: text.slice(index, end + 1) });
    cursor = Math.max(index + 4, end + 1);
  }
  return matches;
}

function imagePropsFromElement(image: HTMLImageElement, sourceDocName: string): ImageProps | null {
  const src = image.getAttribute('src');
  if (src === null || resolveAssetProjectPath(src, sourceDocName) === null) return null;

  const loading = image.getAttribute('loading');
  const decoding = image.getAttribute('decoding');
  const fetchpriority = image.getAttribute('fetchpriority');
  const crossorigin = image.getAttribute('crossorigin');
  const referrerpolicy = image.getAttribute('referrerpolicy');
  return {
    src: normalizeDocRelativeAssetUrl(src, sourceDocName),
    alt: image.getAttribute('alt') ?? '',
    width: image.getAttribute('width') ?? undefined,
    height: image.getAttribute('height') ?? undefined,
    title: image.getAttribute('title') ?? undefined,
    srcset: image.getAttribute('srcset') ?? undefined,
    sizes: image.getAttribute('sizes') ?? undefined,
    loading: loading === 'eager' || loading === 'lazy' ? loading : undefined,
    decoding:
      decoding === 'sync' || decoding === 'async' || decoding === 'auto' ? decoding : undefined,
    fetchpriority:
      fetchpriority === 'high' || fetchpriority === 'low' || fetchpriority === 'auto'
        ? fetchpriority
        : undefined,
    crossorigin:
      crossorigin === '' || crossorigin === 'anonymous' || crossorigin === 'use-credentials'
        ? crossorigin
        : undefined,
    referrerpolicy:
      referrerpolicy === '' ||
      referrerpolicy === 'no-referrer' ||
      referrerpolicy === 'no-referrer-when-downgrade' ||
      referrerpolicy === 'origin' ||
      referrerpolicy === 'origin-when-cross-origin' ||
      referrerpolicy === 'same-origin' ||
      referrerpolicy === 'strict-origin' ||
      referrerpolicy === 'strict-origin-when-cross-origin' ||
      referrerpolicy === 'unsafe-url'
        ? referrerpolicy
        : undefined,
  };
}

/** Parse one complete, lowercase, non-self-closing local HTML image tag. */
export function parseBareHtmlImage(raw: string, sourceDocName: string): ImageProps | null {
  if (!raw.startsWith('<img') || raw.endsWith('/>')) return null;
  const template = document.createElement('template');
  template.innerHTML = raw;
  if (template.content.childNodes.length !== 1) return null;
  const image = template.content.firstElementChild;
  if (!(image instanceof HTMLImageElement)) return null;
  return imagePropsFromElement(image, sourceDocName);
}

function isLiteralOnlyContext(node: ProseMirrorNode, parent: ProseMirrorNode | null): boolean {
  if (parent?.type.spec.code === true || parent?.type.name.toLowerCase().includes('codeblock')) {
    return true;
  }
  return node.marks.some((mark) =>
    ['code', 'escapeMark', 'sourceLiteral'].includes(mark.type.name),
  );
}

/** Locate only raw-HTML-origin text, excluding escaped and code-shaped literals. */
export function findRenderableBareHtmlImages(
  doc: ProseMirrorNode,
  sourceDocName: string,
): RenderableBareHtmlImage[] {
  const images: RenderableBareHtmlImage[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || node.text === undefined || isLiteralOnlyContext(node, parent)) return;
    for (const match of findBareHtmlImageTags(node.text)) {
      const props = parseBareHtmlImage(match.raw, sourceDocName);
      if (props === null) continue;
      const from = pos + match.index;
      images.push({ ...match, from, to: from + match.raw.length, props });
    }
  });
  return images;
}

function buildDecorations(
  doc: ProseMirrorNode,
  editor: Editor,
  sourceDocName: string,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const match of findRenderableBareHtmlImages(doc, sourceDocName)) {
    const { from, to, props } = match;
    let renderer: ReactRenderer<typeof BareImg> | null = null;
    decorations.push(
      Decoration.inline(from, to, {
        'aria-hidden': 'true',
        class: 'hidden ok-bare-html-image-source',
      }),
      Decoration.widget(
        from,
        () => {
          renderer = new ReactRenderer(BareImg, {
            editor,
            props,
            as: 'span',
            className: 'ok-bare-html-image-render',
          });
          renderer.element.setAttribute('contenteditable', 'false');
          return renderer.element;
        },
        {
          side: -1,
          key: `${from}:${match.raw}`,
          destroy: () => renderer?.destroy(),
        },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}

export function createBareHtmlImageDecoration(sourceDocName: string): Extension {
  return Extension.create({
    name: 'bareHtmlImageDecoration',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin<DecorationSet>({
          key: pluginKey,
          state: {
            init: (_, state) => buildDecorations(state.doc, editor, sourceDocName),
            apply: (transaction, previous) =>
              transaction.docChanged
                ? buildDecorations(transaction.doc, editor, sourceDocName)
                : previous.map(transaction.mapping, transaction.doc),
          },
          props: {
            decorations: (state) => pluginKey.getState(state) ?? DecorationSet.empty,
          },
        }),
      ];
    },
  });
}
