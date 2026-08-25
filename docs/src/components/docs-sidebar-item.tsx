'use client';

import type * as PageTree from 'fumadocs-core/page-tree';
import { SidebarItem } from 'fumadocs-ui/components/layout/sidebar';
import { docsSidebarLabel } from '@/lib/sidebar-title';

// This client boundary lets the server layout pass a component through
// Fumadocs' sidebar config. The Fumadocs primitive still owns icon rendering,
// external-link rel/target, and active-state detection.
export function DocsSidebarItem({ item }: { item: PageTree.Item }) {
  return (
    <SidebarItem href={item.url} external={item.external} icon={item.icon}>
      {docsSidebarLabel(item)}
    </SidebarItem>
  );
}
