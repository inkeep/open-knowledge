/**
 * Tabs — Notion-style horizontal tab strip + active panel container.
 *
 * Mirrors Accordion's shape: single jsxComponent descriptor in
 * `core/registry/built-ins.ts` (canonical, hasChildren), paired with the Tab
 * descriptor for individual panels. NO HTML5 `<details>` substrate (Tabs is
 * exclusive-active, not collapse-each), NO MutationObserver (kept simple),
 * NO mutation of PM-managed child DOM (CSS rules handle hiding).
 *
 * ── Active-tab lifecycle ─────────────────────────────────────────────────────
 *
 * `activeIndex` lives in this component's `useState`, defaults to 0. Not in
 * the PM doc — selection is ephemeral, same as Notion / Mintlify / fumadocs.
 * The wrapper element carries `data-active-index={N}`; CSS rules in
 * `globals.css` hide all `.react-renderer` siblings under
 * `.component-children > [data-node-view-content-react]` and re-show the
 * N+1-th one. The chain hops twice because Tiptap renders each child
 * NodeView inside a `.react-renderer.node-jsxComponent` div (from
 * @tiptap/react's ReactRenderer) which itself lives inside PM's
 * `contentDOMElement` (a `[data-node-view-content-react]` div that
 * ReactNodeViewRenderer appends inside the React `NodeViewContent` element).
 * PM children stay live (Precedent #30) — they're just not painted.
 *
 * ── Strip rendering & index space ────────────────────────────────────────────
 *
 * The strip needs each Tab's `label` and a stable `id` (for ARIA pairing). We
 * read this Tabs's OWN direct Tab renderers — scoped with `:scope >` to mirror
 * the CSS `:nth-of-type` reveal chain in `globals.css` exactly — and extract
 * the inline `data-tab-label` / `data-tab-id` set by Tab.tsx's render (no
 * setAttribute mutations). The direct-child scoping is load-bearing: a Tab is
 * itself a PM container with its own contentDOM, so a recursive `.react-renderer`
 * walk would sweep in every nested nodeview (a Callout, a Steps and its Steps,
 * a nested Tabs) and emit a phantom pill per grandchild, drifting the strip
 * index space away from the CSS reveal. A non-Tab block legally allowed by the
 * `block*` content expression still occupies one slot with a fallback label,
 * so the two index spaces stay aligned and the correct panel reveals.
 *
 * ── Auto-switch on add ───────────────────────────────────────────────────────
 *
 * When the user clicks the `+ Add Tab` pill (JsxComponentView's container
 * affordance), a new Tab lands at the END of the Tabs's content. PM then
 * fires `focusInsertedComponent` → `requestAnimationFrame(setNodeSelection)`,
 * which is what eventually flips `selected` true on the new Tab and triggers
 * its mount-effect `consumeAutoOpen` → `setPopoverOpen(true)`. If
 * `activeIndex` still points at the previous active when the popover opens,
 * the new wrapper is `display: none` and Radix can't compute a position
 * (it pins to the viewport top-left).
 *
 * Both the label-read AND the count-grew-→-bump-active updates live in
 * `useLayoutEffect`s here. That settles the cascade (read labels → setState
 * → re-render → snap activeIndex → re-render) BEFORE the browser paints and
 * therefore before the deferred `setNodeSelection` rAF runs. By the time
 * `selected` flips and the popover opens, the new Tab's wrapper is visible.
 * Using `useEffect` for the label-read would defer the cascade past paint,
 * leaving a one-frame window where the rAF could fire against a still-hidden
 * wrapper.
 *
 * ── Deep-link via `#hash` ────────────────────────────────────────────────────
 *
 * `<Tab id="foo">` writes `id="foo"` on its `<section>`. If the Tab isn't
 * active, the section is `display: none` and browsers refuse to scroll. We
 * listen to `hashchange` (and run once on mount) — when the hash matches a
 * Tab id, snap `activeIndex` to that Tab and `scrollIntoView` after the
 * paint. The Tabs container's own `id` activates index 0 (matches the
 * descriptor description claim that `<Tabs id="x">` is deep-linkable).
 *
 * ── Notion-style rename gesture ──────────────────────────────────────────────
 *
 * Clicking an INACTIVE pill activates that tab (standard tablist behavior).
 * Clicking the pill that is ALREADY active opens its `<Tab>` properties
 * popover — the same popover the chrome-bar gear opens. Solves the
 * discoverability gap UX research caught: users could not figure out how to
 * rename a tab and got stuck before finding the gear inside the tab body's
 * hover chrome. The active-pill onClick dispatches `.click()` on the
 * resolved gear button (`findNthTabGearButton`), which fires the Radix
 * `PopoverTrigger` whose `<Tab>` Label PropDef has `autoFocus: true` — so
 * focus lands on the Label input ready to type.
 */

import { useLingui } from '@lingui/react/macro';
import { useLayoutEffect, useRef, useState } from 'react';
import { useJsxComponentHost } from './jsx-host-context.tsx';

interface TabsProps {
  id?: string;
  children?: React.ReactNode;
}

interface TabSummary {
  index: number;
  label: string;
  panelId: string | null;
}

const SLOT_SELECTOR =
  ':scope > .component-children > [data-node-view-content-react] > .react-renderer';

export function readTabSlots(root: HTMLElement): TabSummary[] {
  const renderers = Array.from(root.querySelectorAll<HTMLElement>(SLOT_SELECTOR));
  return renderers.map((r, i) => {
    const tabEl = r.querySelector<HTMLElement>('[data-tab-label]');
    const fromAttr = tabEl?.getAttribute('data-tab-label');
    const label = fromAttr?.trim() || `Tab ${i + 1}`;
    const panelId = tabEl?.getAttribute('data-tab-id') ?? null;
    return { index: i, label, panelId };
  });
}

export function findNthTabGearButton(root: HTMLElement, index: number): HTMLButtonElement | null {
  const renderers = Array.from(root.querySelectorAll<HTMLElement>(SLOT_SELECTOR));
  const target = renderers[index];
  if (!target) return null;
  return target.querySelector<HTMLButtonElement>('[data-jsx-gear]');
}

export function Tabs({ id, children }: TabsProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [labels, setLabels] = useState<TabSummary[]>([]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const prevLabelCountRef = useRef(0);
  const host = useJsxComponentHost();
  const canAddTab = host?.addChild != null;
  const { t } = useLingui();

  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const next = readTabSlots(root);
    setLabels((prev) => {
      if (prev.length !== next.length) return next;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].label !== next[i].label || prev[i].panelId !== next[i].panelId) return next;
      }
      return prev;
    });
  });

  useLayoutEffect(() => {
    if (labels.length > prevLabelCountRef.current && labels.length > 0) {
      setActiveIndex(labels.length - 1);
    }
    prevLabelCountRef.current = labels.length;
  }, [labels.length]);

  useLayoutEffect(() => {
    const resolveHash = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      if (id && hash === id) {
        setActiveIndex(0);
        return;
      }
      const root = contentRef.current;
      if (!root) return;
      const slots = readTabSlots(root);
      const idx = slots.findIndex((s) => s.panelId === hash);
      if (idx < 0) return;
      setActiveIndex(idx);
      queueMicrotask(() => {
        const el = root.ownerDocument.getElementById(hash);
        el?.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
    };
    resolveHash();
    window.addEventListener('hashchange', resolveHash);
    return () => window.removeEventListener('hashchange', resolveHash);
  });

  const safeActive =
    labels.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), labels.length - 1);

  const handleStripKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (labels.length === 0) return;
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (safeActive + 1) % labels.length;
    else if (e.key === 'ArrowLeft') nextIndex = (safeActive - 1 + labels.length) % labels.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = labels.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    setActiveIndex(nextIndex);
    const buttons = stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div className="tabs" id={id}>
      <div className="tabs-strip" contentEditable={false}>
        <div
          ref={stripRef}
          role="tablist"
          aria-label={id ? `Tabs: ${id}` : 'Tabs'}
          className="tabs-tablist"
          onKeyDown={handleStripKeyDown}
        >
          {labels.map((s) => {
            const tabButtonId = s.panelId ? `${s.panelId}-tab` : undefined;
            return (
              <button
                key={s.index}
                id={tabButtonId}
                type="button"
                role="tab"
                className="tabs-strip-pill"
                data-active={s.index === safeActive}
                aria-selected={s.index === safeActive}
                aria-controls={s.panelId ?? undefined}
                tabIndex={s.index === safeActive ? 0 : -1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (s.index !== safeActive) {
                    setActiveIndex(s.index);
                    return;
                  }
                  const root = contentRef.current;
                  if (!root) return;
                  findNthTabGearButton(root, s.index)?.click();
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {canAddTab && (
          <button
            type="button"
            className="tabs-strip-add"
            aria-label={t`Add tab`}
            title={t`Add tab`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => host?.addChild?.()}
            data-tabs-strip-add=""
          >
            +
          </button>
        )}
      </div>
      <div ref={contentRef} className="tabs-content" data-active-index={safeActive}>
        {children}
      </div>
    </div>
  );
}
