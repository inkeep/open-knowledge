'use client';

import {
  Tab as FumadocsTab,
  Tabs as FumadocsTabs,
  type TabProps,
  type TabsProps,
} from 'fumadocs-ui/components/tabs';
import * as React from 'react';

export function slugifyTabId(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function composeTabId(
  label: string | undefined,
  groupId: string | undefined,
): string | null {
  const labelSlug = label ? slugifyTabId(label) : '';
  if (!labelSlug) return null;
  const groupSlug = groupId ? slugifyTabId(groupId) : '';
  return groupSlug ? `${groupSlug}-${labelSlug}` : labelSlug;
}

interface TabsDeepLinkCtx {
  items: readonly string[] | undefined;
  groupId: string | undefined;
  collection: string[];
}

const TabsDeepLinkContext = React.createContext<TabsDeepLinkCtx | null>(null);

export function Tabs({
  items,
  groupId,
  updateAnchor = true,
  children,
  ...rest
}: TabsProps): React.JSX.Element {
  const [collection] = React.useState<string[]>(() => []);
  const ctx: TabsDeepLinkCtx = { items, groupId, collection };
  return (
    <TabsDeepLinkContext.Provider value={ctx}>
      <FumadocsTabs items={items} groupId={groupId} updateAnchor={updateAnchor} {...rest}>
        {children}
      </FumadocsTabs>
    </TabsDeepLinkContext.Provider>
  );
}

export function Tab({ id: explicitId, ...rest }: TabProps): React.JSX.Element {
  const key = React.useId();
  const ctx = React.use(TabsDeepLinkContext);
  React.useEffect(() => {
    if (!ctx) return;
    return () => {
      const idx = ctx.collection.indexOf(key);
      if (idx !== -1) ctx.collection.splice(idx, 1);
    };
  }, [ctx, key]);
  let index = -1;
  if (ctx) {
    if (!ctx.collection.includes(key)) ctx.collection.push(key);
    index = ctx.collection.indexOf(key);
  }
  let resolvedId = explicitId;
  if (resolvedId === undefined && ctx && index >= 0) {
    const label = ctx.items?.[index];
    resolvedId = composeTabId(label, ctx.groupId) ?? `tab-${index + 1}`;
  }
  return <FumadocsTab id={resolvedId} {...rest} />;
}
