/**
 * Either path is greenfield-compatible with the precedent #9 schema-add-only contract; the choice
 * depends on whether the extension surface lands as a host-API (b) or in-product (a).
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

const coreRegistry = createRegistry();

interface Decoration {
  // biome-ignore lint/suspicious/noExplicitAny: Component props are heterogeneous across 18+ built-ins; no single prop type covers all
  Component: React.ComponentType<any>;
  reactNodePropNames: ReadonlySet<string>;
}

const decorations = new Map<string, Decoration>();

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

export function getDescriptor(name: string): JsxComponentDescriptor {
  const meta = coreRegistry.getOrWildcard(name);
  const deco = decorations.get(meta.name) ?? decorations.get('*');
  if (!deco) {
    throw new Error(`No React component registered for ${meta.name} (and no '*' wildcard)`);
  }
  return composeDescriptor(meta, deco);
}

export function getRegisteredDescriptors(): JsxComponentDescriptor[] {
  const result: JsxComponentDescriptor[] = [];
  for (const [name, meta] of coreRegistry.entries()) {
    if (name === '*') continue;
    const deco = decorations.get(name);
    if (deco) result.push(composeDescriptor(meta, deco));
  }
  return result;
}
