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
  bar.tabIndex = -1;
  bar.setAttribute(OPT_OUT_ATTR, 'true');
  bar.innerHTML = PLUS_ICON;
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  return bar;
}

interface TableOverlay {
  container: HTMLElement;
  colBar: HTMLButtonElement;
  rowBar: HTMLButtonElement;
  placement: string;
  cleanup: () => void;
}

class TableInsertControlsView {
  private readonly overlays = new Map<HTMLElement, TableOverlay>();
  private readonly mount: HTMLElement;
  private lastEditable: boolean;
  private readonly view: EditorView;
  private readonly editor: Editor;
  private readonly resizeObserver: ResizeObserver | null;
  private positionFrame: number | null = null;

  constructor(view: EditorView, editor: Editor) {
    this.view = view;
    this.editor = editor;
    this.mount = view.dom.parentElement ?? view.dom;
    this.lastEditable = editor.isEditable;
    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.positionAll());
    this.resizeObserver?.observe(view.dom);
    this.reconcile();
  }

  update(_view: EditorView, prevState: EditorState): void {
    const editableChanged = this.editor.isEditable !== this.lastEditable;
    this.lastEditable = this.editor.isEditable;
    if (!editableChanged && prevState.doc.eq(this.view.state.doc)) return;
    this.reconcile();
    this.schedulePositionAll();
  }

  destroy(): void {
    this.removeAllOverlays();
    this.resizeObserver?.disconnect();
    if (this.positionFrame != null) cancelAnimationFrame(this.positionFrame);
    this.positionFrame = null;
  }

  private schedulePositionAll(): void {
    if (this.positionFrame != null || this.overlays.size === 0) return;
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = null;
      this.positionAll();
    });
  }

  private positionAll(): void {
    const placements = Array.from(this.overlays, ([wrapper, overlay]) => {
      const table = wrapper.getBoundingClientRect();
      const origin = overlay.container.getBoundingClientRect();
      const left = table.left - origin.left;
      const top = table.top - origin.top;
      return { overlay, left, top, width: table.width, height: table.height };
    });
    for (const { overlay, left, top, width, height } of placements) {
      const placement = `${left}|${top}|${width}|${height}`;
      if (overlay.placement === placement) continue;
      overlay.placement = placement;
      Object.assign(overlay.colBar.style, {
        left: `${left + width}px`,
        top: `${top}px`,
        height: `${height}px`,
      });
      Object.assign(overlay.rowBar.style, {
        left: `${left}px`,
        top: `${top + height}px`,
        width: `${width}px`,
      });
    }
  }

  private reconcile(): void {
    if (!this.editor.isEditable) {
      this.removeAllOverlays();
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

    this.resizeObserver?.observe(wrapper);
    this.overlays.set(wrapper, {
      container,
      colBar,
      rowBar,
      placement: '',
      cleanup: () => {
        this.resizeObserver?.unobserve(wrapper);
        wrapper.removeEventListener('pointerover', onPointerOver);
        wrapper.removeEventListener('pointerleave', onPointerLeave);
        container.remove();
      },
    });
  }

  private removeAllOverlays(): void {
    for (const wrapper of this.overlays.keys()) this.removeOverlay(wrapper);
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
