interface ScrollOffset {
  readonly top: number;
  readonly left: number;
}

const trackedOffsets = new WeakMap<HTMLElement, Map<Element, ScrollOffset>>();
const restoring = new WeakSet<Element>();
const retrying = new WeakSet<HTMLElement>();
const RESTORE_RETRY_FRAMES = 30;

function offsetsFor(host: HTMLElement): Map<Element, ScrollOffset> {
  let offsets = trackedOffsets.get(host);
  if (offsets === undefined) {
    offsets = new Map();
    trackedOffsets.set(host, offsets);
  }
  return offsets;
}

function hasLayout(element: Element): boolean {
  if (element.getClientRects().length > 0) return true;
  return Array.from(element.children).some((child) => child.getClientRects().length > 0);
}

function scrollRoots(host: HTMLElement): Array<HTMLElement | ShadowRoot> {
  const roots: Array<HTMLElement | ShadowRoot> = [host];
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return roots;
}

function composedContains(host: HTMLElement, element: Element): boolean {
  let node: Node | null = element;
  while (node) {
    if (node === host) return true;
    const root: Node = node.getRootNode();
    node = node.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

function recordVisibleOffsets(host: HTMLElement): void {
  if (!hasLayout(host)) return;
  const offsets = offsetsFor(host);
  for (const root of scrollRoots(host)) {
    for (const element of root.querySelectorAll('*')) {
      if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
        offsets.set(element, { top: element.scrollTop, left: element.scrollLeft });
      }
    }
  }
}

function reapplyHostScroll(host: HTMLElement, framesLeft = RESTORE_RETRY_FRAMES): void {
  const offsets = trackedOffsets.get(host);
  if (offsets === undefined) return;
  let clamped = false;
  for (const [element, offset] of offsets) {
    if (!element.isConnected || !composedContains(host, element)) {
      offsets.delete(element);
      continue;
    }
    if (!hasLayout(element)) continue;
    if (element.scrollTop === offset.top && element.scrollLeft === offset.left) continue;
    restoring.add(element);
    element.scrollTop = offset.top;
    element.scrollLeft = offset.left;
    if (element.scrollTop !== offset.top || element.scrollLeft !== offset.left) clamped = true;
  }
  if (!clamped || framesLeft <= 0 || retrying.has(host)) return;
  retrying.add(host);
  requestAnimationFrame(() => {
    retrying.delete(host);
    reapplyHostScroll(host, framesLeft - 1);
  });
}

export function moveHostPreservingScroll(host: HTMLElement, target: Node): void {
  recordVisibleOffsets(host);
  target.appendChild(host);
  reapplyHostScroll(host);
}

export function observeHostScrollRestore(host: HTMLElement, observed: Element): () => void {
  const onScroll = (event: Event) => {
    const element = event.target;
    if (!(element instanceof Element) || !hasLayout(element)) return;
    if (restoring.delete(element)) return;
    offsetsFor(host).set(element, { top: element.scrollTop, left: element.scrollLeft });
  };
  const roots = scrollRoots(host);
  for (const root of roots) root.addEventListener('scroll', onScroll, true);
  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => reapplyHostScroll(host));
  observer?.observe(observed);
  return () => {
    observer?.disconnect();
    for (const root of roots) root.removeEventListener('scroll', onScroll, true);
  };
}
