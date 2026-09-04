import { parseGlobalSkillBundleDoc, parseProjectSkillBundleDoc } from '@inkeep/open-knowledge-core';
import { type GraphData, getGraphLinkEndpointId } from './graph-view-utils';

export type GraphSkillVisibility = 'all' | 'hide-builtins' | 'none';

function bundleKeyForDocName(docName: string): string | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) return `project:${project.name}`;
  const global = parseGlobalSkillBundleDoc(docName);
  if (global) return `global:${global.name}`;
  return null;
}

export function filterGraphSkillNodes(
  data: GraphData,
  visibility: GraphSkillVisibility,
): GraphData {
  if (visibility === 'all') return data;

  const bundleKeyByNodeId = new Map<string, string>();
  const managedBundleKeys = new Set<string>();
  for (const node of data.nodes) {
    if (node.kind !== 'doc') continue;
    const bundleKey = bundleKeyForDocName(node.docName);
    if (bundleKey === null) continue;
    bundleKeyByNodeId.set(node.id, bundleKey);
    if (node.managed === true) managedBundleKeys.add(bundleKey);
  }
  if (bundleKeyByNodeId.size === 0) return data;

  const referencedBundles = new Set<string>();
  if (visibility === 'hide-builtins') {
    for (const link of data.links) {
      const sourceBundle = bundleKeyByNodeId.get(getGraphLinkEndpointId(link.source)) ?? null;
      const targetBundle = bundleKeyByNodeId.get(getGraphLinkEndpointId(link.target)) ?? null;
      if (sourceBundle === targetBundle) continue;
      if (targetBundle !== null) referencedBundles.add(targetBundle);
    }
  }

  const hiddenNodeIds = new Set<string>();
  for (const [nodeId, bundleKey] of bundleKeyByNodeId) {
    const hidden =
      visibility === 'none' ||
      (managedBundleKeys.has(bundleKey) && !referencedBundles.has(bundleKey));
    if (hidden) hiddenNodeIds.add(nodeId);
  }
  if (hiddenNodeIds.size === 0) return data;

  return {
    nodes: data.nodes.filter((node) => !hiddenNodeIds.has(node.id)),
    links: data.links.filter(
      (link) =>
        !hiddenNodeIds.has(getGraphLinkEndpointId(link.source)) &&
        !hiddenNodeIds.has(getGraphLinkEndpointId(link.target)),
    ),
  };
}
