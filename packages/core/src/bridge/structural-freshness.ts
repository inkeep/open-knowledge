import { type PmStructuralNode, structuralDivergence } from './pm-structural-equivalence.ts';

const RESOLVER_DERIVED_ATTRS = new Set(['src', 'href', 'size']);
const WIKI_EMBED_COMPONENTS = new Set([
  'WikiEmbedImage',
  'WikiEmbedVideo',
  'WikiEmbedAudio',
  'WikiEmbedFile',
]);

function deepDropResolverKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepDropResolverKeys(entry)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (RESOLVER_DERIVED_ATTRS.has(key)) continue;
      out[key] = deepDropResolverKeys(entry);
    }
    return out as T;
  }
  return value;
}

/** Comparison-form of a tree with resolver-derived keys dropped inside every
 *  WikiEmbed* subtree (and only there — see `RESOLVER_DERIVED_ATTRS`). */
function stripResolverDerivedAttrs(node: PmStructuralNode): PmStructuralNode {
  if (
    node.type === 'jsxComponent' &&
    typeof node.attrs?.componentName === 'string' &&
    WIKI_EMBED_COMPONENTS.has(node.attrs.componentName)
  ) {
    return deepDropResolverKeys(node);
  }
  if (!node.content) return node;
  return { ...node, content: node.content.map(stripResolverDerivedAttrs) };
}

function stripMdastPositions<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripMdastPositions(entry)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'position') continue;
      out[key] = stripMdastPositions(entry);
    }
    return out as T;
  }
  return value;
}

/** First `jsxComponent` in document order, or undefined. `parse(sourceRaw)` of
 *  a single component's bytes yields a document whose first (and only top-level)
 *  jsxComponent is that component's reconstruction. */
function firstJsxComponent(root: PmStructuralNode): PmStructuralNode | undefined {
  if (root.type === 'jsxComponent') return root;
  if (root.content) {
    for (const child of root.content) {
      const found = firstJsxComponent(child);
      if (found) return found;
    }
  }
  return undefined;
}

export interface StructuralFreshnessCheckerOptions {
  parse: (sourceRaw: string) => PmStructuralNode;
  cacheLimit?: number;
}

export interface StructuralFreshnessChecker {
  isDiverged(node: PmStructuralNode): boolean;
}

export function createStructuralFreshnessChecker(
  opts: StructuralFreshnessCheckerOptions,
): StructuralFreshnessChecker {
  const cacheLimit = opts.cacheLimit ?? 2048;
  const reparseCache = new Map<string, PmStructuralNode | null>();

  const reparsedStripped = (sourceRaw: string): PmStructuralNode | null => {
    const cached = reparseCache.get(sourceRaw);
    if (cached !== undefined) return cached;
    const found = firstJsxComponent(opts.parse(sourceRaw));
    const value = found ? stripResolverDerivedAttrs(stripMdastPositions(found)) : null;
    if (reparseCache.size >= cacheLimit) {
      const oldest = reparseCache.keys().next().value;
      if (oldest !== undefined) reparseCache.delete(oldest);
    }
    reparseCache.set(sourceRaw, value);
    return value;
  };

  return {
    isDiverged(node) {
      if (node.type !== 'jsxComponent' || !node.attrs || node.attrs.kind === 'expression') {
        return false;
      }
      const sourceRaw = node.attrs.sourceRaw;
      if (typeof sourceRaw !== 'string' || sourceRaw.length === 0) return false;
      const reparsed = reparsedStripped(sourceRaw);
      if (!reparsed) return false;
      return structuralDivergence(reparsed, stripResolverDerivedAttrs(stripMdastPositions(node)));
    },
  };
}
