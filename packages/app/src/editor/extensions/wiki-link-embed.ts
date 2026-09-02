import {
  WikiLinkEmbed as BaseWikiLinkEmbed,
  extractAssetExtension,
  IMAGE_EXTENSIONS,
  resolveAssetProjectPath,
} from '@inkeep/open-knowledge-core';
import { ReactRenderer } from '@tiptap/react';
import { getInteractionLayer } from '../interaction-layer-host';
import { activateAssetLink } from '../internal-link-helpers';
import { WikiLinkEmbedImageView } from './WikiLinkEmbedImageView';

let __wikiLinkEmbedNodeIdCounter = 0;

function nextWikiLinkEmbedNodeId(): string {
  return `wiki-link-embed-${++__wikiLinkEmbedNodeIdCounter}`;
}

interface BuildChipDomResult {
  dom: HTMLElement;
}

function buildWikiLinkEmbedChipDom(params: {
  nodeId: string;
  target: string;
  alias: string | null;
  anchor: string | null;
  href: string;
  doc?: Pick<Document, 'createElement' | 'createTextNode'>;
}): BuildChipDomResult {
  const docImpl: Pick<Document, 'createElement' | 'createTextNode'> =
    params.doc ??
    (typeof document !== 'undefined'
      ? document
      : ({
          createElement: null as never,
          createTextNode: null as never,
        } as never));

  const dom = docImpl.createElement('a') as HTMLElement;
  dom.setAttribute('data-wiki-embed', '');
  dom.setAttribute('data-node-id', params.nodeId);
  dom.setAttribute('data-target', params.target);
  dom.setAttribute('data-alias', params.alias ?? '');
  dom.setAttribute('data-anchor', params.anchor ?? '');
  dom.setAttribute('href', params.href);
  dom.setAttribute('target', '_blank');
  dom.setAttribute('rel', 'noopener noreferrer');
  dom.setAttribute('contenteditable', 'false');
  dom.setAttribute('role', 'button');
  dom.setAttribute('tabindex', '0');
  dom.setAttribute(
    'aria-label',
    `Embed: ${params.target}${params.anchor ? `#${params.anchor}` : ''}`,
  );
  dom.classList.add('wiki-link-embed-chip');
  dom.style.touchAction = 'manipulation';

  const labelText = params.alias ?? `${params.target}${params.anchor ? `#${params.anchor}` : ''}`;
  const labelNode = docImpl.createTextNode(labelText);
  dom.appendChild(labelNode);

  return { dom };
}

export function applyWikiLinkEmbedImageDomAttributes(
  dom: HTMLElement,
  params: {
    nodeId: string;
    target: string;
    alias: string | null;
  },
): void {
  dom.setAttribute('data-wiki-embed', '');
  dom.setAttribute('data-node-id', params.nodeId);
  dom.setAttribute('data-target', params.target);
  dom.setAttribute('data-alias', params.alias ?? '');
  dom.setAttribute('contenteditable', 'false');
}

function isImageExtension(target: string): boolean {
  const ext = extractAssetExtension(target);
  return ext !== null && IMAGE_EXTENSIONS.has(ext);
}

export function resolveWikiEmbedActivation(attrs: {
  target: string;
  resolvedSrc: string | null;
}): { url: string; projectRelPath: string; ext: string; title: string } | null {
  const target = attrs.target;
  if (!target) return null;
  const url = attrs.resolvedSrc && attrs.resolvedSrc.length > 0 ? attrs.resolvedSrc : target;
  const ext = extractAssetExtension(target);
  if (ext === null) return null;
  const projectRelPath = resolveAssetProjectPath(url, '', { literal: true });
  if (projectRelPath === null) return null;
  return {
    url,
    projectRelPath,
    ext,
    title: projectRelPath.split('/').pop() ?? url,
  };
}

export const WikiLinkEmbed = BaseWikiLinkEmbed.extend({
  addNodeView() {
    return ({ editor, node, getPos }) => {
      const nodeId = nextWikiLinkEmbedNodeId();
      let currentNode = node;

      const target = String(node.attrs.target ?? '');
      const alias = node.attrs.alias != null ? String(node.attrs.alias) : null;
      const anchor = node.attrs.anchor != null ? String(node.attrs.anchor) : null;
      const resolvedSrc = node.attrs.resolvedSrc != null ? String(node.attrs.resolvedSrc) : null;
      const isImage = isImageExtension(target);

      if (isImage) {
        const src = resolvedSrc ?? target;
        const renderer = new ReactRenderer(WikiLinkEmbedImageView, {
          editor,
          props: { src, alt: alias ?? target },
          as: 'span',
          className: 'wiki-link-embed-image',
        });
        const dom = renderer.element;
        applyWikiLinkEmbedImageDomAttributes(dom, { nodeId, target, alias });
        return {
          dom,
          ignoreMutation: () => true,
          update: (updatedNode) => {
            if (updatedNode.type.name !== 'wikiLinkEmbed') return false;
            currentNode = updatedNode;
            const newTarget = String(updatedNode.attrs.target ?? '');
            const newAlias =
              updatedNode.attrs.alias != null ? String(updatedNode.attrs.alias) : null;
            const newResolvedSrc =
              updatedNode.attrs.resolvedSrc != null ? String(updatedNode.attrs.resolvedSrc) : null;
            if (!isImageExtension(newTarget)) return false;
            const newSrc = newResolvedSrc ?? newTarget;
            applyWikiLinkEmbedImageDomAttributes(dom, {
              nodeId,
              target: newTarget,
              alias: newAlias,
            });
            renderer.updateProps({ src: newSrc, alt: newAlias ?? newTarget });
            return true;
          },
          destroy: () => renderer.destroy(),
        };
      }

      const href = resolvedSrc ?? target;
      const { dom } = buildWikiLinkEmbedChipDom({ nodeId, target, alias, anchor, href });

      dom.addEventListener('click', (ev) => {
        ev.preventDefault();
      });

      const safeGetPos = (): number | undefined => {
        const pos = getPos();
        return typeof pos === 'number' ? pos : undefined;
      };

      const layer = getInteractionLayer(editor);
      layer.register({
        type: 'wikiLinkEmbed',
        nodeId,
        getPos: safeGetPos,
        controls: {},
        handlePrimary: ({ newTab }) => {
          const live = currentNode.attrs;
          const activation = resolveWikiEmbedActivation({
            target: typeof live.target === 'string' ? live.target : '',
            resolvedSrc: typeof live.resolvedSrc === 'string' ? live.resolvedSrc : null,
          });
          if (activation === null) return false;
          activateAssetLink({ ...activation, newTab });
          return true;
        },
      });

      return {
        dom,
        ignoreMutation: () => true,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'wikiLinkEmbed') return false;
          currentNode = updatedNode;
          const newTarget = String(updatedNode.attrs.target ?? '');
          if (isImageExtension(newTarget)) return false;
          const newAlias = updatedNode.attrs.alias != null ? String(updatedNode.attrs.alias) : null;
          const newAnchor =
            updatedNode.attrs.anchor != null ? String(updatedNode.attrs.anchor) : null;
          const newResolvedSrc =
            updatedNode.attrs.resolvedSrc != null ? String(updatedNode.attrs.resolvedSrc) : null;
          const newHref = newResolvedSrc ?? newTarget;
          dom.setAttribute('data-target', newTarget);
          dom.setAttribute('data-alias', newAlias ?? '');
          dom.setAttribute('data-anchor', newAnchor ?? '');
          dom.setAttribute('href', newHref);
          dom.setAttribute('aria-label', `Embed: ${newTarget}${newAnchor ? `#${newAnchor}` : ''}`);
          const newLabel = newAlias ?? `${newTarget}${newAnchor ? `#${newAnchor}` : ''}`;
          dom.textContent = newLabel;
          return true;
        },
        destroy: () => {
          layer.deregister(nodeId);
        },
      };
    };
  },
});
