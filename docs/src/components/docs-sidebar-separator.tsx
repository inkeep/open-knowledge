'use client';

import type * as PageTree from 'fumadocs-core/page-tree';

// Custom sidebar section label (the `---GET STARTED---` separators in meta.json).
// Lives in a 'use client' module so it can be passed as `sidebar.components.Separator`
// across the Server -> Client boundary (a raw function prop can't cross it; a client
// reference can). Owning the markup keeps styling off Fumadocs' internal classes.
export function DocsSidebarSeparator({ item }: { item: PageTree.Separator }) {
  return (
    <p className="mb-1.5 mt-6 flex items-center gap-1.5 px-2 text-1sm font-medium uppercase tracking-wider font-mono text-fd-muted-foreground first:mt-0">
      {item.icon}
      {item.name}
    </p>
  );
}
