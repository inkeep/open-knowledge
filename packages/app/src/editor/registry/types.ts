/**
 * App-side descriptor — core `JsxComponentMeta` decorated with the React
 * component and reactnode-prop set.
 *
 * `reactNodePropNames` is pre-computed once at registry build time so NodeViews
 * don't reconstruct it per render. Any per-render
 * work in a jsxComponent NodeView multiplies across every component in the
 * doc on every PM transaction.
 *
 * Type shape: intersection over the discriminated union, so the `surface`
 * discriminator narrows naturally — `descriptor.surface === 'compat'` exposes
 * `rendersAs`/`translateProps`. An `interface extends` clause cannot extend a
 * union, so this MUST stay a `type` alias.
 */
import type { JsxComponentMeta } from '@inkeep/open-knowledge-core';

interface JsxComponentDecoration {
  // biome-ignore lint/suspicious/noExplicitAny: Component props are heterogeneous across 18+ built-ins; no single prop type covers all
  Component: React.ComponentType<any>;
  /** Pre-computed set of prop names typed as `reactnode`. Stable per descriptor. */
  reactNodePropNames: ReadonlySet<string>;
}

export type JsxComponentDescriptor = JsxComponentMeta & JsxComponentDecoration;
