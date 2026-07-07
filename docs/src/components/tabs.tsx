'use client';

/**
 * Local wrapper around fumadocs-ui's `Tabs` / `Tab` that turns on URL-hash
 * deep-linking by default and auto-derives a slugged `id` per tab from its
 * label.
 *
 * Why wrap instead of using fumadocs directly:
 *   1. Fumadocs ships the machinery (`updateAnchor` writes `#${id}` on tab
 *      change; on mount it reads `window.location.hash` and activates a
 *      matching `<Tab id>`). Both knobs are OFF in our usage today —
 *      `<Tabs>` calls don't pass `updateAnchor`, and `<Tab>` calls don't
 *      pass an explicit `id`, so the `valueToIdMap` stays empty and no
 *      hash ever fires. Wrapping flips both defaults so every `<Tabs>`
 *      block in the docs deep-links without per-call opt-in.
 *   2. When `<Tabs items={[...]}>` uses the simple-mode label-array,
 *      authors write bare `<Tab>` children with no props. The wrapper
 *      slugs the corresponding label and passes it as the `id` so URLs
 *      stay meaningful (`#macos-app`, not `#tab-0`).
 *
 * Explicit `<Tab id="...">` wins — authors can pin a stable id when a
 * label rename shouldn't break inbound links.
 *
 * Multi-Tabs-per-page disambiguation: when the parent `<Tabs>` carries a
 * `groupId` (already used for fumadocs's cross-instance state sync), the
 * tab id gets prefixed with the slugged groupId — `<Tabs groupId="install"
 * items={['macOS app', ...]}>` becomes `#install-macos-app`. Avoids
 * collisions when two `<Tabs>` blocks on the same page share a label.
 *
 * Implementation note: `React.cloneElement` to inject `id` doesn't work
 * here because MDX wraps every child component, so `child.type` is an
 * anonymous wrapper, not the imported `FumadocsTab` reference (no way to
 * identify which children to inject into). Instead, `Tabs` publishes the
 * `items` + `groupId` via a React context, and `Tab` consumes it,
 * computing its own id from its position-in-siblings (tracked via the
 * same `useId` + collection pattern fumadocs uses internally for the
 * simple-mode `value` derivation).
 */

import {
  Tab as FumadocsTab,
  Tabs as FumadocsTabs,
  type TabProps,
  type TabsProps,
} from 'fumadocs-ui/components/tabs';
import * as React from 'react';

/**
 * Pure slug helper: lowercase, strip diacritics, replace any non-ASCII-
 * alphanumeric run with a single dash, trim leading/trailing dashes. Empty
 * input + all-non-alphanum input both return `''`; callers fall back to a
 * positional id (`tab-${n}`) so we never write `#` to the URL.
 *
 * Exported (named) so the unit test can pin the slug rules — the URL shape
 * is a load-bearing contract for shared links (rename a label, the link
 * breaks; this helper is the single point of truth for that contract).
 */
export function slugifyTabId(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Compose the per-tab hash id from the label and the optional `groupId`.
 * `groupId` is the namespace prefix; `label` is what the user sees in the
 * pill. Returns `null` when the label slugs to empty (missing / whitespace
 * / non-alphanumeric) — caller falls back to a positional id.
 *
 * Exported alongside `slugifyTabId` because the prefix-composition is the
 * SECOND half of the load-bearing URL contract for shared links — same
 * regression class, same pinning need. The two helpers compose
 * (`composeTabId` calls `slugifyTabId` on each part); pinning composition
 * directly catches an inverted prefix order or a dropped prefix that the
 * slug-only tests would miss.
 */
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

/**
 * Drop-in `<Tabs>` for our MDX. Defaults `updateAnchor: true` so every tab
 * switch writes `history.replaceState('', '', '#${id}')` and every page
 * load that lands with `#${id}` activates the matching tab. Author opt-out
 * is `updateAnchor={false}`.
 */
export function Tabs({
  items,
  groupId,
  updateAnchor = true,
  children,
  ...rest
}: TabsProps): React.JSX.Element {
  // Per-Tabs collection of registered `useId` keys, mirroring fumadocs's
  // own internal collection. `Tab` registers its `useId` here on first
  // render; the position in this array is the same index fumadocs uses to
  // resolve `value = items[index]` — keeping the two index spaces aligned
  // is what makes slug→id mapping match the rendered pill. `useState` with
  // a lazy initializer creates the mutable array once and returns the SAME
  // reference on every subsequent render (we never call the setter). This
  // is the React-Compiler-clean equivalent of a `useRef` (which can't be
  // read during render under the docs site's strict
  // `panicThreshold: 'all_errors'` compiler config). `useMemo` would also
  // work but is discouraged repo-wide per the Code style rule in CLAUDE.md.
  const [collection] = React.useState<string[]>(() => []);
  // Inline literal — React Compiler memoizes the object. An explicit memo
  // would not stabilize anyway because MDX hands `items` as a fresh array
  // literal on every render (`items={['macOS app', ...]}` → new array).
  const ctx: TabsDeepLinkCtx = { items, groupId, collection };
  return (
    <TabsDeepLinkContext.Provider value={ctx}>
      <FumadocsTabs items={items} groupId={groupId} updateAnchor={updateAnchor} {...rest}>
        {children}
      </FumadocsTabs>
    </TabsDeepLinkContext.Provider>
  );
}

/**
 * Wrapping `Tab` so we can resolve its sibling index + auto-derive its id
 * from the parent `Tabs`'s `items[index]`. The pattern (a `useId` key
 * pushed into a shared `collection` array; this Tab's position = the
 * array index) is the same one fumadocs uses internally for
 * `useCollectionIndex` to know which `items[]` entry maps to each
 * unlabelled `<Tab>`. Mirroring it here keeps slug→id mapping byte-aligned
 * with the value→pill mapping the rendered DOM uses.
 *
 * `id` precedence: explicit prop > auto-slugged > positional fallback.
 */
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
