/* STOP: this hint ships `aria-hidden` because every final-block type already has its own
   keyboard route to a trailing paragraph. The routes differ per type, and Gapcursor
   reaches only the table, thematic-break, atom and isolating cases, so a Gapcursor-only
   replacement silently strips the heading, list and code-fence routes. Do not make the
   hint focusable or swap out the pointer path without re-deriving all of them. Full
   route table and derivation: `packages/app/src/editor/README.md` (internal, and not
   part of the public mirror). */
import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import { insertParagraphAt } from '../selection/place-caret.ts';
import { ASK_COMPOSER_HEIGHT_VAR } from '../utils/editor-visible-region.ts';
import { GUTTER_PLUS_SVG } from './gutter-plus-icon.ts';

export const OK_TRAILING_AFFORDANCE_CLASS = 'ok-trailing-affordance';

export const trailingAffordanceKey = new PluginKey<boolean>('trailingAffordance');

export function docNeedsTrailingAffordance(doc: Pick<PmNode, 'lastChild'>): boolean {
  const last = doc.lastChild;
  return last != null && last.type.name !== 'paragraph';
}

function lastBlockBottom(view: EditorView): number | null {
  const { doc } = view.state;
  const last = doc.lastChild;
  if (!last) return null;
  const dom = view.nodeDOM(doc.content.size - last.nodeSize);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  if (rect.height === 0 && rect.top === 0) return null;
  return rect.bottom;
}

function composerInset(view: EditorView): number {
  const px = Number.parseFloat(
    getComputedStyle(view.dom).getPropertyValue(ASK_COMPOSER_HEIGHT_VAR),
  );
  return Number.isFinite(px) ? px : 0;
}

function inTrailingZone(view: EditorView, event: MouseEvent): boolean {
  if (!view.editable) return false;
  if (!docNeedsTrailingAffordance(view.state.doc)) return false;
  const target = event.target;
  if (target instanceof Element && target.closest(`.${OK_TRAILING_AFFORDANCE_CLASS}`)) return true;
  const top = lastBlockBottom(view);
  if (top == null) return false;
  const dom = view.dom.getBoundingClientRect();
  const bottom = dom.bottom - composerInset(view);
  return (
    event.clientY > top &&
    event.clientY <= bottom &&
    event.clientX >= dom.left &&
    event.clientX <= dom.right
  );
}

export function appendTrailingParagraph(view: EditorView): void {
  if (!insertParagraphAt(view, view.state.doc.content.size)) return;
  view.focus();
}

export function renderHint(): HTMLElement {
  const row = document.createElement('div');
  row.className = OK_TRAILING_AFFORDANCE_CLASS;
  row.setAttribute(OPT_OUT_ATTR, 'true');
  row.setAttribute('contenteditable', 'false');
  row.setAttribute('aria-hidden', 'true');
  const plus = document.createElement('span');
  plus.className = `${OK_TRAILING_AFFORDANCE_CLASS}-plus`;
  plus.innerHTML = GUTTER_PLUS_SVG;
  row.append(plus);
  return row;
}

function setHovered(view: EditorView, next: boolean): void {
  if (trailingAffordanceKey.getState(view.state) === next) return;
  view.dispatch(view.state.tr.setMeta(trailingAffordanceKey, next).setMeta('addToHistory', false));
}

const PRESS_SLOP_PX = 4;

function coarsePointerQuery(): MediaQueryList | null {
  return typeof window === 'undefined' ? null : (window.matchMedia?.('(pointer: coarse)') ?? null);
}

export function trailingAffordancePlugin(): Plugin<boolean> {
  let press: { id: number; x: number; y: number } | null = null;
  const coarse = coarsePointerQuery();

  function activate(view: EditorView, event: PointerEvent): boolean {
    const origin = press;
    if (!origin || origin.id !== event.pointerId) return false;
    press = null;
    if (
      Math.abs(event.clientX - origin.x) > PRESS_SLOP_PX ||
      Math.abs(event.clientY - origin.y) > PRESS_SLOP_PX
    ) {
      return false;
    }
    if (!view.state.selection.empty) return false;
    if (!inTrailingZone(view, event)) return false;
    event.preventDefault();
    appendTrailingParagraph(view);
    setHovered(view, view.editable && coarse?.matches === true);
    return true;
  }

  return new Plugin<boolean>({
    key: trailingAffordanceKey,
    state: {
      init: () => false,
      apply(tr, value) {
        const meta = tr.getMeta(trailingAffordanceKey);
        return typeof meta === 'boolean' ? meta : value;
      },
    },
    view(view) {
      const sync = () => setHovered(view, view.editable && coarse?.matches === true);
      let wasEditable = view.editable;
      queueMicrotask(() => {
        if (view.isDestroyed) return;
        sync();
      });
      coarse?.addEventListener('change', sync);
      return {
        update(updated) {
          if (updated.editable === wasEditable) return;
          wasEditable = updated.editable;
          sync();
        },
        destroy() {
          coarse?.removeEventListener('change', sync);
        },
      };
    },
    props: {
      decorations(state) {
        if (trailingAffordanceKey.getState(state) !== true) return null;
        if (!docNeedsTrailingAffordance(state.doc)) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(state.doc.content.size, renderHint, { side: 1 }),
        ]);
      },
      handleDOMEvents: {
        mousemove(view, event) {
          if (coarse?.matches) return false;
          setHovered(view, inTrailingZone(view, event as MouseEvent));
          return false;
        },
        mouseleave(view) {
          if (coarse?.matches) return false;
          setHovered(view, false);
          return false;
        },
        pointerdown(view, event) {
          const pointer = event as PointerEvent;
          if (press && press.id !== pointer.pointerId) return false;
          press = null;
          if (pointer.button !== 0 || pointer.ctrlKey) return false;
          if (!inTrailingZone(view, pointer)) return false;
          press = { id: pointer.pointerId, x: pointer.clientX, y: pointer.clientY };
          return false;
        },
        pointerup(view, event) {
          return activate(view, event as PointerEvent);
        },
        pointercancel(_view, event) {
          const pointer = event as PointerEvent;
          if (press?.id === pointer.pointerId) press = null;
          return false;
        },
      },
    },
  });
}

export const TrailingAffordance = Extension.create({
  name: 'trailingAffordance',

  addProseMirrorPlugins() {
    return [trailingAffordancePlugin()];
  },
});
