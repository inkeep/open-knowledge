'use client';

import { Children, isValidElement, type ReactNode, useState } from 'react';

export function TabPreview({ children }: { label: string; children?: ReactNode }) {
  return <>{children}</>;
}

export function TabsPreview({ children }: { children?: ReactNode }) {
  const tabs = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const props = (child as { props: { label?: string; children?: ReactNode } }).props;
      return { label: props.label ?? '', body: props.children };
    })
    .filter((tab) => tab.label.length > 0);
  const [active, setActive] = useState(0);
  if (tabs.length === 0) return null;
  const current = tabs[Math.min(active, tabs.length - 1)];

  return (
    <div className="w-full">
      <div className="mb-3 flex gap-1 border-fd-border border-b" role="tablist">
        {tabs.map((tab, i) => {
          const isActive = i === active;
          return (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(i)}
              className={
                isActive
                  ? '-mb-px border-fd-primary border-b-2 px-3 py-1.5 text-fd-foreground text-sm'
                  : '-mb-px border-b-2 border-transparent px-3 py-1.5 text-fd-muted-foreground text-sm hover:text-fd-foreground'
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="text-fd-foreground text-sm">
        {current.body}
      </div>
    </div>
  );
}
