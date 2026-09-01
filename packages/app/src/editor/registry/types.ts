import type { JsxComponentMeta } from '@inkeep/open-knowledge-core';

interface JsxComponentDecoration {
  // biome-ignore lint/suspicious/noExplicitAny: Component props are heterogeneous across 18+ built-ins; no single prop type covers all
  Component: React.ComponentType<any>;
  reactNodePropNames: ReadonlySet<string>;
}

export type JsxComponentDescriptor = JsxComponentMeta & JsxComponentDecoration;
