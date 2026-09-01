import type * as PageTree from 'fumadocs-core/page-tree';

export type DocsPageTreeItem = PageTree.Item & { sidebarTitle?: string };

export function withSidebarTitle(node: PageTree.Item, sidebarTitle: string): DocsPageTreeItem {
  return { ...node, sidebarTitle } satisfies PageTree.Item & { sidebarTitle: string };
}

export function docsSidebarLabel(item: DocsPageTreeItem) {
  return item.sidebarTitle?.trim() || item.name;
}
