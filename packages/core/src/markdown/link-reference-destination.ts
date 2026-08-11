import type { Definition, LinkReference, Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { normalizeReferenceLabel } from './reference-label.ts';

function labelKey(node: Definition | LinkReference): string | null {
  const raw = node.identifier ?? node.label;
  if (typeof raw !== 'string') return null;
  const key = normalizeReferenceLabel(raw);
  return key.length > 0 ? key : null;
}

function collectDefinitions(tree: Root): Map<string, Definition> {
  const byLabel = new Map<string, Definition>();
  visit(tree, 'definition', (node: Definition) => {
    const key = labelKey(node);
    if (key && !byLabel.has(key)) byLabel.set(key, node);
  });
  return byLabel;
}

export function linkReferenceDestinationPlugin() {
  return (tree: Root) => {
    const definitions = collectDefinitions(tree);
    if (definitions.size === 0) return;
    visit(tree, 'linkReference', (node: LinkReference) => {
      const key = labelKey(node);
      if (!key) return;
      const definition = definitions.get(key);
      if (!definition) return;
      node.data = {
        ...node.data,
        resolvedUrl: definition.url,
        resolvedTitle: definition.title ?? null,
      };
    });
  };
}
