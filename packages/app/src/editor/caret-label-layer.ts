import { autoUpdate, computePosition, hide, offset, platform } from '@floating-ui/dom';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const CARET_SELECTOR = '.collaboration-cursor__caret';
const LAYER_CLASS = 'collaboration-cursor__label-layer';

const caretLabels = new WeakMap<HTMLElement, HTMLElement>();

export function attachCaretLabel(caret: HTMLElement, label: HTMLElement): void {
  caretLabels.set(caret, label);
}

interface MountedLabel {
  label: HTMLElement;
  update: () => void;
  stop: () => void;
}

const physicalPlatform = { ...platform, isRTL: () => false };

function setLabelPlacement(label: HTMLElement, position: { x: number; y: number } | null): void {
  label.style.left = `${position?.x ?? 0}px`;
  label.style.top = `${position?.y ?? 0}px`;
  label.style.visibility = position ? '' : 'hidden';
}

function positionLabel(caret: HTMLElement, label: HTMLElement): void {
  void computePosition(caret, label, {
    strategy: 'absolute',
    platform: physicalPlatform,
    placement: 'top-start',
    middleware: [offset({ mainAxis: 2, crossAxis: -1 }), hide()],
  })
    .then(({ x, y, middlewareData }) => {
      setLabelPlacement(label, middlewareData.hide?.referenceHidden ? null : { x, y });
    })
    .catch((error: unknown) => {
      setLabelPlacement(label, null);
      console.warn('[caret-label-layer] computePosition failed; label hidden', error);
    });
}

function mountLabel(layer: HTMLElement, caret: HTMLElement, label: HTMLElement): MountedLabel {
  layer.append(label);
  const update = () => positionLabel(caret, label);
  const stopAutoUpdate = autoUpdate(caret, label, update);
  return {
    label,
    update,
    stop: () => {
      stopAutoUpdate();
      label.remove();
    },
  };
}

class CaretLabelLayerView {
  private readonly view: EditorView;
  private readonly layer: HTMLDivElement;
  private readonly mounted = new Map<HTMLElement, MountedLabel>();
  private readonly attachObserver: ResizeObserver | null;

  constructor(view: EditorView) {
    this.view = view;
    this.layer = document.createElement('div');
    this.layer.className = LAYER_CLASS;
    this.layer.setAttribute('aria-hidden', 'true');
    this.attachObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.reconcile());
    this.attachObserver?.observe(view.dom);
    this.reconcile();
  }

  update(): void {
    this.reconcile();
  }

  destroy(): void {
    this.attachObserver?.disconnect();
    for (const entry of this.mounted.values()) entry.stop();
    this.mounted.clear();
    this.layer.remove();
  }

  private placeLayerBesideDocument(): void {
    const parent = this.view.dom.parentElement;
    if (parent && this.layer.parentElement !== parent) parent.append(this.layer);
  }

  private reconcile(): void {
    this.placeLayerBesideDocument();
    const live = new Set<HTMLElement>();
    for (const caret of this.view.dom.querySelectorAll<HTMLElement>(CARET_SELECTOR)) {
      const label = caretLabels.get(caret);
      if (!label) continue;
      live.add(caret);
      const existing = this.mounted.get(caret);
      if (existing) {
        existing.update();
        continue;
      }
      this.mounted.set(caret, mountLabel(this.layer, caret, label));
    }
    for (const [caret, entry] of this.mounted) {
      if (live.has(caret)) continue;
      entry.stop();
      this.mounted.delete(caret);
    }
  }
}

const caretLabelLayerKey = new PluginKey('caretLabelLayer');

export function caretLabelLayerPlugin(): Plugin {
  return new Plugin({
    key: caretLabelLayerKey,
    view: (view) => new CaretLabelLayerView(view),
  });
}
