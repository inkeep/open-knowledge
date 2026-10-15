import type { EditorView } from '@codemirror/view';
import axe from 'axe-core';

interface Color {
  r: number;
  g: number;
  b: number;
  alpha: number;
  parseString(value: string): void;
}

const { Color: AxeColor } = (axe.commons as unknown as { color: { Color: new () => Color } }).color;

type Rgba = [number, number, number, number];

export function rgba(value: string): Rgba {
  const color = new AxeColor();
  const normalized = value.trimStart().startsWith('#')
    ? value
    : value.replace(/[-+]?\d*\.?\d+e[-+]?\d+/gi, (part) => Number(part).toFixed(20));
  color.parseString(normalized);
  const channels: Rgba = [Number(color.r), Number(color.g), Number(color.b), Number(color.alpha)];
  if (channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`Color parser returned non-finite channels for ${value}`);
  }
  return channels;
}

function over(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3];
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
    1,
  ];
}

function luminance(color: Rgba): number {
  const linear = color
    .slice(0, 3)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function parentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function textMeasurement(element: Element, overlay?: Element) {
  const layers: { background: string; opacity: number; selection?: string }[] = [];
  const content = overlay ? element.closest('.cm-content') : null;
  if (overlay && !content)
    throw new Error('Selection backdrop needs a CodeMirror content boundary');
  let ancestor: Element | null = element;
  while (ancestor) {
    const style = getComputedStyle(ancestor);
    if (Number(style.opacity) !== 1)
      throw new Error(`Unmeasured group opacity on ${ancestor.tagName}`);
    if (style.backgroundImage !== 'none')
      throw new Error(`Unmeasured background image on ${ancestor.tagName}`);
    layers.push({
      background: style.backgroundColor,
      opacity: Number(style.opacity),
      ...(ancestor === content && overlay
        ? { selection: getComputedStyle(overlay).backgroundColor }
        : {}),
    });
    ancestor = parentElement(ancestor);
  }
  let background: Rgba = [1, 1, 1, 1];
  for (const layer of layers.toReversed()) {
    if (layer.selection) background = over(rgba(layer.selection), background);
    const color = rgba(layer.background);
    background = over(color, background);
  }
  const foregroundCss = getComputedStyle(element).color;
  const foreground = rgba(foregroundCss);
  const paintedForeground = over(foreground, background);
  const fg = luminance(paintedForeground);
  const bg = luminance(background);
  return {
    text: element.textContent?.trim(),
    foreground: foregroundCss,
    selectionOverlay: overlay ? getComputedStyle(overlay).backgroundColor : null,
    background: background.slice(0, 3),
    layers,
    ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
  };
}

export function textLeaves(root: Element | ShadowRoot): Element[] {
  return Array.from(root.querySelectorAll('*')).filter((element) => {
    if (element.tagName === 'STYLE' || element.tagName === 'SCRIPT') return false;
    if (
      !Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      )
    )
      return false;
    let ancestor: Element | null = element;
    while (ancestor) {
      if (Number(getComputedStyle(ancestor).opacity) === 0) return false;
      ancestor = parentElement(ancestor);
    }
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

export function sourceCharacterMeasurements(view: EditorView, from: number, to: number) {
  const selections = Array.from(view.dom.querySelectorAll('.cm-selectionBackground')).map(
    (element) => ({ element, rect: element.getBoundingClientRect() }),
  );
  const readings = [];
  const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    for (let offset = 0; offset < text.length; offset++) {
      const position = view.posAtDOM(node, offset);
      if (position < from || position >= to) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0)
        throw new Error(`Unrendered source character ${position}`);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const selection = selections.find(
        ({ rect }) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom,
      );
      const element = node.parentElement;
      if (!element) throw new Error(`Missing source character parent ${position}`);
      readings.push({
        ...textMeasurement(element, selection?.element),
        position,
        text: text[offset],
        selected: selection !== undefined,
      });
    }
  }
  if (readings.length !== to - from)
    throw new Error(`Expected ${to - from} source characters, measured ${readings.length}`);
  return readings;
}
