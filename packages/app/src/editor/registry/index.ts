/**
 * App-side descriptor registry — decorates core's `ComponentRegistry`
 * with React component implementations from `componentMap`.
 *
 * Core owns the wildcard-fallback semantic (`getOrWildcard`) and the
 * built-in manifest. The app layer adds a per-name `{ Component,
 * reactNodePropNames }` decoration lookup and routes meta reads through
 * the core factory.
 *
 * ## Extensibility (today: the 5-pack only)
 *
 * The current 5-pack ships fully sealed: `componentMap` is a static
 * `Record<string, ComponentType>` populated at module init from the
 * built-in imports (Callout/Image/Video/Audio/Accordion + wildcard).
 * The decoration `Map` is also populated once at module init by walking
 * `coreRegistry.entries()`, so a post-init `coreRegistry.set('Widget',
 * meta)` would land `meta` in the metadata registry but produce NO
 * matching decoration — `getDescriptor('Widget')` would fall through to
 * the `'*'` wildcard, ignoring the new metadata's `props` / `Component`
 * /`hasChildren`.
 *
 * User-registered custom components (deferred) would convert
 * `coreRegistry.set` into a true runtime extensibility surface. Two paths
 * are open and both stay additive:
 *   (a) Lazy-build decorations: `getDescriptor` looks up
 *       `coreRegistry.get(name)` on miss and synthesizes a
 *       decoration from a registered React component AND a future
 *       `registerComponent(name, Component)` API on `componentMap`.
 *   (b) Hand the `componentMap` registration responsibility to the
 *       embedder via a host-API wrapper — same shape as fumadocs's
 *       `mdxComponents` registry.
 * Either path is greenfield-compatible with the precedent #9
 * schema-add-only contract; the choice depends on whether the
 * extension surface lands as a host-API (b) or in-product (a).
 *
 * Callers MUST treat the registry as read-only at runtime —
 * `coreRegistry.set` exists for module-init seeding only.
 */
import { createRegistry, type JsxComponentMeta, type PropDef } from '@inkeep/open-knowledge-core';
import { componentMap } from '../components/componentMap.tsx';
import type { JsxComponentDescriptor } from './types.ts';

function computeReactNodePropNames(props: PropDef[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const p of props) {
    if (p.type === 'reactnode') names.add(p.name);
  }
  return names;
}

/**
 * The module-level core registry — single source of truth for metadata.
 * App-level decorations (`Component`, `reactNodePropNames`) live in a
 * sibling lookup keyed by the same name.
 */
const coreRegistry = createRegistry();

interface Decoration {
  // biome-ignore lint/suspicious/noExplicitAny: Component props are heterogeneous across 18+ built-ins; no single prop type covers all
  Component: React.ComponentType<any>;
  reactNodePropNames: ReadonlySet<string>;
}

const decorations = new Map<string, Decoration>();

/**
 * Build the React-component decoration for a descriptor.
 *
 * - `surface: 'canonical'` → look up the React component by `meta.name`.
 *   Returns null if `componentMap` doesn't have the canonical's component
 *   (e.g., during module init before `componentMap` is seeded).
 * - `surface: 'compat'` → look up the React component by `meta.rendersAs`.
 *   Compat descriptors render through the canonical's component via the
 *   render-time `translateProps` step in `JsxComponentView`. Throws if
 *   `rendersAs` doesn't resolve to a registered canonical — fail loud at
 *   module init rather than render an undefined component.
 *
 * Note: `reactNodePropNames` is computed from the descriptor's OWN `props`
 * (not the canonical's). Compat descriptors expose a subset of props; the
 * reactnode set is a subset accordingly.
 */
function buildDecoration(meta: JsxComponentMeta): Decoration | null {
  if (meta.surface === 'compat') {
    const Component = componentMap[meta.rendersAs];
    if (!Component) {
      throw new Error(
        `Compat descriptor '${meta.name}' declares rendersAs: '${meta.rendersAs}', but no React component is registered under that name in componentMap. Add the canonical component before registering the compat descriptor.`,
      );
    }
    return {
      Component,
      reactNodePropNames: computeReactNodePropNames(meta.props),
    };
  }
  const Component = componentMap[meta.name];
  if (!Component) return null;
  return {
    Component,
    reactNodePropNames: computeReactNodePropNames(meta.props),
  };
}

// Seed decorations for the wildcard + every built-in whose React component
// ships in `componentMap`. Compat descriptors resolve via `rendersAs` and
// throw at init if their canonical isn't registered. Any future
// `coreRegistry.set(name, meta)` that also lands a matching entry in
// `componentMap` will render correctly the next time `getDescriptor` is
// called; entries without a render component fall through to the wildcard
// via `getOrWildcard`.
for (const [name, meta] of coreRegistry.entries()) {
  const deco = buildDecoration(meta);
  if (deco) decorations.set(name, deco);
}

function composeDescriptor(meta: JsxComponentMeta, deco: Decoration): JsxComponentDescriptor {
  return {
    ...meta,
    Component: deco.Component,
    reactNodePropNames: deco.reactNodePropNames,
  };
}

/**
 * Lookup a descriptor by component name. Returns the wildcard `'*'`
 * descriptor for unregistered names (core owns the fallback semantic).
 */
export function getDescriptor(name: string): JsxComponentDescriptor {
  const meta = coreRegistry.getOrWildcard(name);
  const deco = decorations.get(meta.name) ?? decorations.get('*');
  if (!deco) {
    // `componentMap['*']` guarantees a wildcard decoration exists at
    // module init. If it doesn't, `componentMap` is mis-seeded — crash
    // loudly rather than render an undefined component.
    throw new Error(`No React component registered for ${meta.name} (and no '*' wildcard)`);
  }
  return composeDescriptor(meta, deco);
}

/**
 * All registered descriptors (excluding wildcard).
 */
export function getRegisteredDescriptors(): JsxComponentDescriptor[] {
  const result: JsxComponentDescriptor[] = [];
  for (const [name, meta] of coreRegistry.entries()) {
    if (name === '*') continue;
    const deco = decorations.get(name);
    if (deco) result.push(composeDescriptor(meta, deco));
  }
  return result;
}
