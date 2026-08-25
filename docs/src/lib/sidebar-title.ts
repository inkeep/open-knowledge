import type * as PageTree from 'fumadocs-core/page-tree';

/**
 * The single declaration of the sidebar-label contract between the page-tree
 * transformer in `source.ts` (producer) and `DocsSidebarItem` (consumer).
 * Fumadocs types the sidebar `Item` slot against the plain `PageTree.Item`, so
 * both sides import this module instead of re-declaring the extension. The
 * producer's required-field check prevents the optional field from being
 * silently dropped while the consumer remains compatible with plain items.
 *
 * Lives outside `source.ts` because the client component calls the label
 * helper at runtime, and `source.ts` pulls in the generated `.source/server`
 * corpus plus the full lucide icon map, none of which belongs in the client
 * bundle.
 */
export type DocsPageTreeItem = PageTree.Item & { sidebarTitle?: string };

/**
 * Attach the short label to a page-tree node. Checking against a required-field
 * variant prevents this producer from silently dropping the otherwise optional
 * field during a refactor.
 */
export function withSidebarTitle(node: PageTree.Item, sidebarTitle: string): DocsPageTreeItem {
  return { ...node, sidebarTitle } satisfies PageTree.Item & { sidebarTitle: string };
}

/**
 * The sidebar row label: the short override when present, else the canonical
 * tree name. Trim-then-falsy rather than `??` so a blank or whitespace-only
 * value from a future producer falls back instead of leaving the row's
 * accessible name empty. Because the extension is optional, plain upstream
 * items remain structurally compatible with this parameter.
 */
export function docsSidebarLabel(item: DocsPageTreeItem) {
  return item.sidebarTitle?.trim() || item.name;
}
