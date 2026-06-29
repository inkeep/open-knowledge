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
