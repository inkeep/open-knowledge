/**
 * Component descriptor registry — runtime Map with wildcard fallback.
 *
 * Registry tracks block components only. Inline JSX uses the thin
 * jsxInline PM node — no descriptors, no dispatch.
 */

export { builtInComponents } from './built-ins.ts';

import { emitMdxJsx } from '../markdown/serialize-helpers.ts';
import { builtInComponents } from './built-ins.ts';
import type { JsxComponentMeta } from './types.ts';

/**
 * The wildcard descriptor — serves any component name not in the registry.
 * hasChildren: true so markdown children remain editable ("bring your own markdown").
 *
 * Tagged `surface: 'canonical'` so render dispatch is uniform — the wildcard's
 * `serialize` is the same MDX-JSX structural reconstruction the canonical 5-pack
 * uses, just with the unregistered name passed through verbatim. The wildcard
 * is technically neither truly canonical nor compat; calling it canonical
 * sidesteps a third surface category that would have no other consumers.
 */
export const wildcardMeta: JsxComponentMeta = {
  name: '*',
  surface: 'canonical',
  hasChildren: true,
  props: [],
  description: 'Unregistered component — children editable as markdown',
  serialize: (node, ctx) => {
    const componentName = (node.attrs.componentName as string) || '*';
    return emitMdxJsx(componentName, node, ctx);
  },
};

export interface ComponentRegistry {
  /**
   * Return the registered descriptor for `name`, or `undefined` if no
   * descriptor is registered under that name. Callers that want the
   * wildcard-fallback semantic should use `getOrWildcard`.
   */
  get(name: string): JsxComponentMeta | undefined;
  /**
   * Return the registered descriptor for `name`, or the wildcard `'*'`
   * descriptor on miss. Use this when you need a descriptor to render
   * against — the wildcard gives you sane defaults (`hasChildren: true`,
   * empty `props`) for unregistered components.
   */
  getOrWildcard(name: string): JsxComponentMeta;
  set(name: string, meta: JsxComponentMeta): void;
  has(name: string): boolean;
  entries(): IterableIterator<[string, JsxComponentMeta]>;
}

/**
 * Creates a registry pre-populated with the 5-pack foundation (Callout,
 * Image, Audio, Video, Accordion) and the wildcard '*' fallback.
 * Additional entries can be added via `registry.set()` (future
 * extensibility seam). Unregistered descriptors fall through to the
 * wildcard — their names remain valid in user content but render
 * generically.
 */
export function createRegistry(): ComponentRegistry {
  const map = new Map<string, JsxComponentMeta>();

  // Register wildcard first
  map.set('*', wildcardMeta);

  // Register all built-ins
  for (const meta of builtInComponents) {
    map.set(meta.name, meta);
  }

  return {
    get(name) {
      return map.get(name);
    },
    getOrWildcard(name) {
      return map.get(name) ?? (map.get('*') as JsxComponentMeta);
    },
    set(name, meta) {
      map.set(name, meta);
    },
    has(name) {
      return map.has(name);
    },
    entries() {
      return map.entries();
    },
  };
}
