'use client';

import type * as PageTree from 'fumadocs-core/page-tree';

export function DocsSidebarSeparator({ item }: { item: PageTree.Separator }) {
  return (
    <p className="mb-1.5 mt-6 flex items-center gap-1.5 px-2 text-1sm font-medium uppercase tracking-wider font-mono text-fd-muted-foreground first:mt-0">
      {item.icon}
      {item.name}
    </p>
  );
}
