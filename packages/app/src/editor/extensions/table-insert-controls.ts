/**
 * TableInsertControls — Notion-style edge "+" bars for tables.
 *
 * Every table gets its own pair of thin buttons: a full-height bar at the right
 * edge (appends a column) and a full-width bar at the bottom edge (appends a
 * row — see `table-insert-commands.ts`). The bars are invisible until the
 * pointer is over them; reveal is pure CSS `:hover` and the click handler binds
 * directly to the button. This is a mouse-convenience layer on top of the
 * keyboard-accessible `TableCellHandles` dropdowns.
 *
 * **Why a per-table DOM overlay positioned with floating-ui** (rather than just
 * putting the buttons inside the table's DOM with CSS):
 *   - prosemirror-tables wraps each table in `.tableWrapper` with
 *     `overflow-x: auto`, which CSS coerces `overflow-y` to `auto` as well — a
 *     button in the right/bottom gutter would be clipped or spawn scrollbars.
 *   - A Table NodeView could add an un-clipped wrapper, but it would collide
 *     with the column-resizing plugin that already owns `.tableWrapper`.
 * So each bar pair is a sibling overlay mounted on `view.dom.parentElement`
 * (OUTSIDE the editor content) and aligned to its `.tableWrapper` with
 * `@floating-ui/dom` — the same positioning mechanism `drag-handle.ts` uses.
 * `autoUpdate` keeps the bars glued through scroll, resize, and the re-flow
 * after an insert. Mounting imperative DOM (not a React component) also avoids
 * the `<Activity>`-flip `removeChild` crash documented in `drag-handle.ts`.
 *
 * The overlays are reconciled against the live `.tableWrapper` set on every
 * document change: new tables get bars, removed tables have theirs torn down.
 */

import { autoUpdate, computePosition } from '@floating-ui/dom';
import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import { appendTableColumn, appendTableRow, findTablePosFromDom } from './table-insert-commands.ts';

const PLUS_ICON = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;

function createBar(orientation: 'column' | 'row', label: string): HTMLButtonElement {
  const bar = document.createElement('button');
  bar.type = 'button';
  bar.className = `ok-table-insert-bar ok-table-insert-${orientation}`;
  bar.setAttribute('aria-label', label);
  // Mouse-only affordance: the bars are always rendered (transparent until
  // hovered), so without this they'd add two focusable tab stops per table.
  // The keyboard path for row/column edits is the TableCellHandles dropdowns.
  // Mirrors the drag-handle grip (drag-handle.ts).
  bar.tabIndex = -1;
  // Closes the clipboard-slice leak by construction if floating-ui ever
  // positions the bar inside the editor doc tree (see drag-handle.ts).
  bar.setAttribute(OPT_OUT_ATTR, 'true');
  bar.innerHTML = PLUS_ICON;
  // Suppress the editor's pointerdown handling so clicking a bar neither moves
  // the selection nor starts a drag — mirrors `ok-add-block-btn`.
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  return bar;
}

/** Per-table overlay: the bars' container plus a single teardown handle. */
interface TableOverlay {
  container: HTMLElement;
  cleanup: () => void;
}

class TableInsertControlsView {
  private readonly overlays = new Map<HTMLElement, TableOverlay>();
  private readonly mount: HTMLElement;
  private lastEditable: boolean;

  constructor(
    private readonly view: EditorView,
    private readonly editor: Editor,
  ) {
    this.mount = view.dom.parentElement ?? view.dom;
    this.lastEditable = editor.isEditable;
    this.reconcile();
  }

  update(_view: EditorView, prevState: EditorState): void {
    // Re-reconcile when the `.tableWrapper` set could have changed: on a doc
    // edit (tables added/removed) or when the editor flips read-only ↔ editable
    // (`setEditable` doesn't touch the doc, but bars must not survive into a
    // read-only view — PM applies a programmatic dispatch regardless).
    const editableChanged = this.editor.isEditable !== this.lastEditable;
    this.lastEditable = this.editor.isEditable;
    if (!editableChanged && prevState.doc.eq(this.view.state.doc)) return;
    this.reconcile();
  }

  destroy(): void {
    // Deleting the current key mid-iteration is safe for a Map iterator.
    for (const wrapper of this.overlays.keys()) this.removeOverlay(wrapper);
  }

  private reconcile(): void {
    if (!this.editor.isEditable) {
      this.destroy();
      return;
    }
    const live = new Set(this.view.dom.querySelectorAll<HTMLElement>('.tableWrapper'));
    for (const wrapper of this.overlays.keys()) {
      if (!live.has(wrapper)) this.removeOverlay(wrapper);
    }
    for (const wrapper of live) {
      if (!this.overlays.has(wrapper)) this.addOverlay(wrapper);
    }
  }

  private addOverlay(wrapper: HTMLElement): void {
    const container = document.createElement('div');
    container.className = 'ok-table-insert-controls';
    container.setAttribute(OPT_OUT_ATTR, 'true');

    const colBar = createBar('column', 'Add column');
    const rowBar = createBar('row', 'Add row');
    colBar.addEventListener('click', () => this.insert(wrapper, appendTableColumn));
    rowBar.addEventListener('click', () => this.insert(wrapper, appendTableRow));
    container.append(colBar, rowBar);
    this.mount.appendChild(container);

    const reposition = (): void => {
      const { width, height } = wrapper.getBoundingClientRect();
      // No floating-ui offset — each bar sits flush against the table edge so
      // its hit box touches the table (no dead zone). The visual gap is a
      // transparent CSS gutter inside the bar (see `.ok-table-insert-bar`),
      // which keeps the gutter hoverable. `right-start`/`bottom-start` align
      // the bar's leading edge with the wrapper's top/left; the cross-axis size
      // is stretched to span the edge. A reference detached by a remote edit
      // before the promise resolves is swallowed by `.catch` (the next
      // autoUpdate tick re-positions) — matches link-path-suggestions.tsx.
      void computePosition(wrapper, colBar, {
        strategy: 'absolute',
        placement: 'right-start',
      })
        .then(({ x, y }) => {
          colBar.style.left = `${x}px`;
          colBar.style.top = `${y}px`;
          colBar.style.height = `${height}px`;
        })
        .catch(() => {});
      void computePosition(wrapper, rowBar, {
        strategy: 'absolute',
        placement: 'bottom-start',
      })
        .then(({ x, y }) => {
          rowBar.style.left = `${x}px`;
          rowBar.style.top = `${y}px`;
          rowBar.style.width = `${width}px`;
        })
        .catch(() => {});
    };

    const stopAutoUpdate = autoUpdate(wrapper, container, reposition);

    // Reveal each bar when the pointer is in the table's last column / last row
    // (the edge the bar would grow). `:hover` on the bar itself (CSS) keeps it
    // lit once the pointer moves onto it. Scoped to this wrapper — no global
    // listeners. GFM tables are rectangular, so "last cell in its row" = last
    // column and "last <tr> in the <tbody>" = last row.
    const onPointerOver = (event: PointerEvent): void => {
      const cell =
        event.target instanceof Element ? event.target.closest<HTMLElement>('td, th') : null;
      const row = cell?.parentElement;
      colBar.classList.toggle('is-active', !!cell && cell === row?.lastElementChild);
      rowBar.classList.toggle('is-active', !!row && row === row.parentElement?.lastElementChild);
    };
    const onPointerLeave = (): void => {
      colBar.classList.remove('is-active');
      rowBar.classList.remove('is-active');
    };
    wrapper.addEventListener('pointerover', onPointerOver);
    wrapper.addEventListener('pointerleave', onPointerLeave);

    this.overlays.set(wrapper, {
      container,
      cleanup: () => {
        stopAutoUpdate();
        wrapper.removeEventListener('pointerover', onPointerOver);
        wrapper.removeEventListener('pointerleave', onPointerLeave);
        container.remove();
      },
    });
  }

  private removeOverlay(wrapper: HTMLElement): void {
    const overlay = this.overlays.get(wrapper);
    if (!overlay) return;
    overlay.cleanup();
    this.overlays.delete(wrapper);
  }

  private insert(
    wrapper: HTMLElement,
    build: (state: EditorState, tablePos: number) => ReturnType<typeof appendTableColumn>,
  ): void {
    const table = wrapper.querySelector<HTMLElement>('table');
    if (!table) return;
    const pos = findTablePosFromDom(this.view, table);
    if (pos === null) return;
    const tr = build(this.view.state, pos);
    if (!tr) return;
    this.view.dispatch(tr);
    this.view.focus();
    // The table grew — autoUpdate's resize observer repositions the bars.
  }
}

export const TableInsertControls = Extension.create({
  name: 'tableInsertControls',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('tableInsertControls'),
        view: (view) => new TableInsertControlsView(view, editor),
      }),
    ];
  },
});
