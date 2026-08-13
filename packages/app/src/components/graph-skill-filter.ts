import { parseGlobalSkillBundleDoc, parseProjectSkillBundleDoc } from '@inkeep/open-knowledge-core';
import { type GraphData, getGraphLinkEndpointId } from './graph-view-utils';

/**
 * How much of the skill layer the graph draws.
 *
 *  - `all`          — every skill node. The docked local graph, which exists to
 *                     show what a given doc (skill included) connects to.
 *  - `hide-builtins`— the fullscreen default: the user's own skills, but not
 *                     OpenKnowledge's, unless something links at one.
 *  - `none`         — no skill nodes at all.
 */
export type GraphSkillVisibility = 'all' | 'hide-builtins' | 'none';

/**
 * Identity of the skill bundle a node belongs to, or null when it is not part of
 * one. Scope is part of the key: a project skill and a global skill can share a
 * name while being separate bundles that never link to each other.
 */
function bundleKeyForDocName(docName: string): string | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) return `project:${project.name}`;
  const global = parseGlobalSkillBundleDoc(docName);
  if (global) return `global:${global.name}`;
  return null;
}

/**
 * Apply skill-node visibility to a graph payload.
 *
 * Which bundles are OpenKnowledge's own is read from the server-set `managed`
 * flag, never re-derived from names here — the reserved names live in the server
 * package, and a second copy in the app would be free to drift.
 *
 * Skill-reference edges are mirrored in the link-graph payload, so direction does
 * not reveal which skill authored a ref. The server-side bundle guard therefore
 * requires managed user-global bundles to author no skill refs. Under that
 * invariant, any edge crossing a managed bundle boundary means another skill
 * references it. Bundle-internal SKILL-to-reference edges do not count because
 * they cross no bundle boundary.
 */
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
