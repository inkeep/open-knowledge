'use client';

import type * as PageTree from 'fumadocs-core/page-tree';
import { SidebarItem } from 'fumadocs-ui/components/layout/sidebar';
import { docsSidebarLabel } from '@/lib/sidebar-title';

export function DocsSidebarItem({ item }: { item: PageTree.Item }) {
  return (
    <SidebarItem href={item.url} external={item.external} icon={item.icon}>
      {docsSidebarLabel(item)}
    </SidebarItem>
  );
}
