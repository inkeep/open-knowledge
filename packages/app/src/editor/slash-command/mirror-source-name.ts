import { graphemePrefix } from '@inkeep/open-knowledge-core/utils/grapheme-clip';
import { toWikiLinkSlug } from '@inkeep/open-knowledge-core/utils/slug';
import type { Node as PmNode } from '@tiptap/pm/model';
import { mirrorSourceNameFromProps } from '../components/use-mirror-source.ts';

const FALLBACK_NAME = 'source';
const MAX_NAME_LENGTH = 40;

function headingAbove(doc: PmNode, pos: number): string {
  let text = '';
  doc.nodesBetween(0, pos, (node, nodePos) => {
    if (node.type.name === 'heading' && nodePos + node.nodeSize <= pos) text = node.textContent;
  });
  return text;
}

function shortName(slug: string): string {
  if (slug.length <= MAX_NAME_LENGTH) return slug;
  const clipped = graphemePrefix(slug, MAX_NAME_LENGTH);
  const lastBreak = clipped.lastIndexOf('-');
  return lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped;
}

function namesInUse(doc: PmNode): ReadonlySet<string> {
  const names = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name !== 'jsxComponent' || node.attrs.componentName !== 'MirrorSource') return;
    const authored = (node.attrs.props as Record<string, unknown> | null) ?? {};
    const name = mirrorSourceNameFromProps(authored);
    if (name !== '') names.add(name);
  });
  return names;
}

export function nextMirrorSourceName(doc: PmNode, pos: number): string {
  const base = shortName(toWikiLinkSlug(headingAbove(doc, pos))) || FALLBACK_NAME;
  const taken = namesInUse(doc);
  if (!taken.has(base)) return base;
  let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
