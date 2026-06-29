
export { builtInComponents } from './built-ins.ts';

import { emitMdxJsx } from '../markdown/serialize-helpers.ts';
import { builtInComponents } from './built-ins.ts';
import type { JsxComponentMeta } from './types.ts';

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
  get(name: string): JsxComponentMeta | undefined;
  getOrWildcard(name: string): JsxComponentMeta;
  set(name: string, meta: JsxComponentMeta): void;
  has(name: string): boolean;
  entries(): IterableIterator<[string, JsxComponentMeta]>;
}

export function createRegistry(): ComponentRegistry {
  const map = new Map<string, JsxComponentMeta>();

  map.set('*', wildcardMeta);

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
