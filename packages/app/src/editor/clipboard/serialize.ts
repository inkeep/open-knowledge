import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import { markdownToHtml } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type { Schema, Slice } from '@tiptap/pm/model';
import { DOMSerializer, Fragment, Slice as SliceCtor } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import {
  type SerializeResult,
  type WalkerEnv,
  walkLiveDomToInlineStyledFragment,
} from './clipboard-walker.ts';
import { classifyError, logSerializeFail } from './instrument.ts';

interface WysiwygSerializerDeps {
  mdManager: MarkdownManager;
}

export interface ClipboardHtmlSerializerHandle {
  serializer: DOMSerializer;
  setView: (view: EditorView) => void;
}

export function createClipboardTextSerializer(deps: WysiwygSerializerDeps) {
  return (slice: Slice, view: EditorView): string => {
    try {
      return sliceToMarkdown(slice, view.state.schema, deps.mdManager);
    } catch (err) {
      logSerializeFail({
        view: 'wysiwyg',
        kind: 'text',
        reason: (err as Error)?.message ?? 'unknown',
      });
      return slice.content.textBetween(0, slice.content.size, '\n\n');
    }
  };
}

class MdastClipboardSerializer extends DOMSerializer {
  private readonly mdManager: MarkdownManager;
  private view: EditorView | null = null;

  constructor(mdManager: MarkdownManager) {
    super({}, {});
    this.mdManager = mdManager;
  }

  setView(view: EditorView): void {
    this.view = view;
  }

  override serializeFragment(
    fragment: Fragment,
    _options?: { document?: Document },
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const view = this.view;
    if (view && view.state.selection.from !== view.state.selection.to) {
      try {
        const slice = view.state.selection.content();
        const env = buildWalkerEnv(view, this.mdManager);
        const walked = walkLiveDomToInlineStyledFragment(slice, view, env);
        if (walked.childNodes.length > 0) {
          if (target) {
            for (const child of Array.from(walked.childNodes)) target.appendChild(child);
            return target;
          }
          return walked;
        }
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'html',
          reason: `walker:${(err as Error)?.message ?? 'unknown'}`,
        });
      }
    }
    try {
      const schema = fragment.firstChild?.type.schema;
      if (!schema) return target ?? document.createDocumentFragment();
      const html = renderFragmentToHtml(fragment, schema, this.mdManager);
      const frag = parseHtmlToDocumentFragment(html);
      if (target) {
        for (const child of Array.from(frag.childNodes)) target.appendChild(child);
        return target;
      }
      return frag;
    } catch (err) {
      logSerializeFail({
        view: 'wysiwyg',
        kind: 'html',
        reason: `markdown:${(err as Error)?.message ?? 'unknown'}`,
      });
      return target ?? document.createDocumentFragment();
    }
  }
}

export function createClipboardHtmlSerializer(
  deps: WysiwygSerializerDeps,
): ClipboardHtmlSerializerHandle {
  const serializer = new MdastClipboardSerializer(deps.mdManager);
  return {
    serializer,
    setView: (view) => serializer.setView(view),
  };
}

function sliceToMarkdown(slice: Slice, schema: Schema, mdManager: MarkdownManager): string {
  return mdManager.serialize(sliceToDocJson(slice, schema));
}

export function findDescriptorRoot(live: Element): Element | null {
  let descriptorRoot: Element | null = null;
  let cur: Element | null = live;
  while (cur && !cur.classList.contains('ProseMirror')) {
    if (cur.hasAttribute('data-clipboard-inline-leaf')) {
      cur = cur.parentElement;
      continue;
    }
    if (
      cur.classList.contains('react-renderer') ||
      cur.hasAttribute('data-node-view-wrapper') ||
      cur.hasAttribute('data-jsx-component')
    ) {
      descriptorRoot = cur;
    }
    cur = cur.parentElement;
  }
  return descriptorRoot;
}

function buildWalkerEnv(view: EditorView, mdManager: MarkdownManager): WalkerEnv {
  return {
    getComputedStyle: (el) => window.getComputedStyle(el),
    serializeElementMarkdown: (live): SerializeResult => {
      const descriptorRoot = findDescriptorRoot(live);
      let pos: number;
      try {
        const parent = descriptorRoot?.parentElement;
        if (parent && descriptorRoot) {
          const idx = Array.from(parent.children).indexOf(descriptorRoot);
          pos = view.posAtDOM(parent, idx, -1);
        } else {
          pos = view.posAtDOM(live, 0);
        }
      } catch (err) {
        return { kind: 'failed', errorClass: classifyError(err) };
      }
      if (pos < 0) return { kind: 'no-correspondence' };
      const node = view.state.doc.nodeAt(pos);
      if (!node) return { kind: 'no-correspondence' };
      const slice = view.state.doc.slice(pos, pos + node.nodeSize);
      try {
        return { kind: 'ok', markdown: sliceToMarkdown(slice, view.state.schema, mdManager) };
      } catch (err) {
        return { kind: 'failed', errorClass: classifyError(err) };
      }
    },
  };
}

function renderFragmentToHtml(
  fragment: Fragment,
  schema: Schema,
  mdManager: MarkdownManager,
): string {
  const slice = new SliceCtor(fragment, 0, 0);
  const markdown = sliceToMarkdown(slice, schema, mdManager);
  return markdownToHtml(markdown);
}

export function sliceToDocJson(slice: Slice, schema: Schema): JSONContent {
  let content = slice.content;
  const first = content.firstChild;
  if (first?.isInline) {
    const paragraph = schema.nodes.paragraph;
    if (paragraph) {
      const wrapped = paragraph.createAndFill(null, content);
      if (wrapped) content = Fragment.from(wrapped);
    }
  }
  const docNode = schema.topNodeType.createAndFill(null, content);
  if (!docNode) {
    const empty = schema.topNodeType.createAndFill();
    if (!empty) throw new Error('[clipboard] schema cannot fill topNodeType');
    return empty.toJSON() as JSONContent;
  }
  return docNode.toJSON() as JSONContent;
}

function parseHtmlToDocumentFragment(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  for (const child of Array.from(doc.body.childNodes)) {
    frag.appendChild(child);
  }
  return frag;
}
