/**
 * App-layer WikiLinkEmbed extension — plain-DOM NodeView routed via the
 * shared InteractionLayer.
 *
 * Mirrors the `wiki-link.ts` pattern (atom-node + module-level counter +
 * InteractionLayer registration + in-place DOM update). Image extensions
 * render as `<img>` (matching the core `renderHTML` output) and do NOT
 * register with the layer — clicking an inline image is a PM-selection
 * operation, not an asset dispatch. Non-image extensions render as a
 * clickable `<a>` chip + register `handlePrimary` → `activateAssetLink`:
 * bare click navigates to the in-app asset preview (sidebar parity),
 * Cmd/Ctrl/middle-click delegates to the OS (Electron) / a new tab (web).
 *
 * Post-roundtrip, the `wikiLinkEmbed` atom is converted by Observer B to
 * PM text + link-mark with `sourceForm: 'wikiembed'`, which routes
 * through `internal-link.ts` `handlePrimary`. This NodeView only fires
 * in the drop-time transient window (between drop and the next save).
 *
 * @see packages/app/src/editor/extensions/wiki-link.ts — the peer atom-
 *   node pattern this file mirrors (buildChipDom + NodeView factory +
 *   closure-captured `currentNode` for PropPanel-edit attr refresh).
 * @see packages/app/src/editor/asset-dispatch/dispatcher.ts — the
 *   Electron-vs-web branching consumed on the OS-delegation path.
 */
import {
  WikiLinkEmbed as BaseWikiLinkEmbed,
  extractAssetExtension,
  IMAGE_EXTENSIONS,
  resolveAssetProjectPath,
  toDesktopAssetHref,
} from '@inkeep/open-knowledge-core';
import { getInteractionLayer } from '../interaction-layer-host';
import { activateAssetLink } from '../internal-link-helpers';

// Module-level monotonic counter — drives the stable `data-node-id`
// attribute used by InteractionLayer's event delegation.
let __wikiLinkEmbedNodeIdCounter = 0;

function nextWikiLinkEmbedNodeId(): string {
  return `wiki-link-embed-${++__wikiLinkEmbedNodeIdCounter}`;
}

interface BuildChipDomResult {
  dom: HTMLElement;
}

/**
 * Build the plain-DOM chip structure for a non-image WikiLinkEmbed
 * NodeView. Exported-style (internal) for unit testing — the DOM layout
 * can be exercised without constructing a full TipTap Editor.
 */
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
  // `target="_blank"` + `rel="noopener noreferrer"` match the core
  // renderHTML behavior — if the InteractionLayer's handlePrimary
  // returns false (or isn't reached for some reason), the browser's
  // default new-tab behavior is the safe fallback.
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

/**
 * Build the plain-DOM `<img>` for image-ext WikiLinkEmbed NodeViews.
 * No InteractionLayer registration — inline images don't have an asset-
 * dispatch click story (clicking selects, same as before this amendment).
 *
 * Exported (internal) for unit testing — the DOM layout + `toDesktopAssetHref`
 * application can be exercised without constructing a full TipTap Editor.
 */
export function buildWikiLinkEmbedImageDom(params: {
  nodeId: string;
  target: string;
  alias: string | null;
  src: string;
  doc?: Pick<Document, 'createElement'>;
}): BuildChipDomResult {
  const docImpl: Pick<Document, 'createElement'> =
    params.doc ??
    (typeof document !== 'undefined' ? document : ({ createElement: null as never } as never));

  const dom = docImpl.createElement('img') as HTMLElement;
  dom.setAttribute('data-wiki-embed', '');
  dom.setAttribute('data-node-id', params.nodeId);
  dom.setAttribute('data-target', params.target);
  dom.setAttribute('data-alias', params.alias ?? '');
  // `resolvedSrc` is server-absolute (`/<contentDir-relative>`); in Electron
  // the page may be at `file://` or a Vite dev URL with no asset middleware,
  // so `/...` resolves against the wrong base. Mirror the rewrite the
  // canonical media components apply (Image.tsx, Video.tsx, Audio.tsx,
  // Pdf.tsx, File.tsx + ImageSrcFidelity.renderHTML).
  dom.setAttribute('src', toDesktopAssetHref(params.src));
  dom.setAttribute('alt', params.alias ?? params.target);
  return { dom };
}

function isImageExtension(target: string): boolean {
  const ext = extractAssetExtension(target);
  return ext !== null && IMAGE_EXTENSIONS.has(ext);
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

      // Image branch: render as `<img>` for inline display. No
      // InteractionLayer registration (images don't route through asset-
      // dispatch — the click is a PM-selection concern).
      if (isImage) {
        const src = resolvedSrc ?? target;
        const { dom } = buildWikiLinkEmbedImageDom({ nodeId, target, alias, src });
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
            // Image-vs-chip branch can flip if `target` is edited from `.pdf`
            // to `.png` (unlikely but possible via prop-panel). PM recreates
            // the NodeView when a node's shape materially changes — return
            // `false` if the new target isn't an image so PM rebuilds.
            if (!isImageExtension(newTarget)) return false;
            const newSrc = newResolvedSrc ?? newTarget;
            dom.setAttribute('data-target', newTarget);
            dom.setAttribute('data-alias', newAlias ?? '');
            dom.setAttribute('src', toDesktopAssetHref(newSrc));
            dom.setAttribute('alt', newAlias ?? newTarget);
            return true;
          },
        };
      }

      // Non-image branch: render as chip + register with InteractionLayer.
      // `handlePrimary` routes to `activateAssetLink`: bare click navigates
      // to the in-app asset preview, Cmd/Ctrl+click delegates to the OS
      // default app (Electron) / a new tab (web).
      const href = resolvedSrc ?? target;
      const { dom } = buildWikiLinkEmbedChipDom({ nodeId, target, alias, anchor, href });

      // Suppress the chip's default new-tab navigation — the
      // InteractionLayer's pointerdown handler routes the click through
      // `handlePrimary`, and we want the dispatcher to be the single
      // source of truth. Without this, an unhandled pointerdown would
      // still fire the `<a>`'s default action as a fallback. The default
      // IS the fallback if `handlePrimary` returns false (defense in
      // depth); but it should not fire alongside successful dispatch.
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
        // No prop-panel yet for wikiLinkEmbed — clicking the chip routes
        // to `activateAssetLink` (bare click: in-app asset preview;
        // Cmd/Ctrl-click: OS default app / new tab). A prop-panel would be
        // a follow-up if users need to edit the target or alias from the
        // editor without going to source mode.
        controls: {},
        handlePrimary: ({ newTab }) => {
          const live = currentNode.attrs;
          const liveTarget = typeof live.target === 'string' ? live.target : '';
          if (!liveTarget) return false;
          const liveResolvedSrc =
            typeof live.resolvedSrc === 'string' && live.resolvedSrc.length > 0
              ? live.resolvedSrc
              : null;
          const liveUrl = liveResolvedSrc ?? liveTarget;
          const ext = extractAssetExtension(liveTarget);
          if (ext === null) return false;
          // Drop-time wikiLinkEmbed always carries a server-absolute
          // `resolvedSrc`, so the resolver
          // ignores the source-doc argument. For the `resolvedSrc === null`
          // edge case (bare target), we pass empty `sourceDocName` to
          // resolve against project root — acceptable because drop-time
          // bare targets are root-level co-located assets. Post-roundtrip
          // asset clicks go through `internal-link.ts` (link-mark with
          // `sourceForm: 'wikiembed'`) which has the full doc context.
          const projectRelPath = resolveAssetProjectPath(liveUrl, '');
          const rel = projectRelPath ?? liveTarget;
          activateAssetLink({
            url: liveUrl,
            projectRelPath: rel,
            ext,
            title: rel.split('/').pop() ?? liveUrl,
            newTab,
          });
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
          // Image-vs-chip flip — PM recreates the NodeView if the branch
          // changes. Return false so the current chip-shaped NodeView is
          // destroyed and a new image-shaped one is built.
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
          // Chips own only a text node today — `textContent =` is safe. If a
          // future change adds child elements (icon, spinner, status dot),
          // switch this to a dedicated label `<span>` child so the icon
          // doesn't get nuked on every label update.
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
