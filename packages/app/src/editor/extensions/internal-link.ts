/**
 * App-layer LinkFidelity extension — plain-DOM chip routed via the shared
 * InteractionLayer.
 *
 * `renderHTML` emits a plain `<span data-link role="link" tabindex="0">`
 * with an `aria-label`. The mark-identity / mark-interaction-bridge /
 * decoration plugin stack attaches `data-mark-id` and `data-resolution-state`
 * decoration attrs at PM render time. The InteractionLayer's event delegation
 * routes pointer AND keyboard activation to the shared PropPanel at editor
 * root. (Previously: per-instance `ReactMarkViewRenderer(InternalLinkView)`
 * mounted one React subtree per `<a>` mark — hundreds of portals per large
 * doc with seconds of React reconciliation cost.)
 *
 * **Click / hover / keyboard semantics**:
 *   - Bare click + Enter on a focused chip navigates via `handlePrimary` —
 *     external opens in a new tab; doc/anchor uses same-tab hash routing.
 *     Unresolved page links (target missing OR folder without index) return
 *     false so the popover surfaces "Create page" / "Create index" actions.
 *   - Cmd/Ctrl+click + middle-click route through `handlePrimary` with
 *     `newTab: true` to open in a new tab.
 *   - Mouse hover (with 300 ms open delay, 150 ms close delay) opens the
 *     singleton `InternalLinkPropPanel`; keyboard focus opens it
 *     immediately. Touch long-press (500 ms) is the touch equivalent.
 *   - Escape dismisses the active PropPanel (handled at the layer).
 *   - The `<a href>` child the React MarkView wrapped its text in
 *     is deliberately omitted — clicking an anchor navigates synchronously
 *     and races the InteractionLayer's click handler.
 *
 * **docName threading:** consumers call `InternalLink.configure({docName})`
 * to bind the active doc name (used by the link-resolution decoration
 * plugin to compute `data-resolution-state` against the page-list cache).
 * `TiptapEditor.tsx` invokes `.configure` with `provider.configuration.name`.
 *
 * Schema unchanged (precedent #9 add-only). All identity + resolution state
 * lives in PluginState / decoration attrs.
 */
import {
  assertNeverLinkTarget,
  classifyMarkdownHref,
  extractAssetExtension,
  LinkFidelity,
  resolveAssetProjectPath,
} from '@inkeep/open-knowledge-core';
import { type Editor, mergeAttributes } from '@tiptap/core';
import { createElement } from 'react';
import { openExternalUrl } from '@/lib/external-link';
import { resolveLinkTargetIntent } from '../../components/link-target-intent';
import {
  activateAssetLink,
  openInternalHashHrefInNewTab,
  toInternalHashHref,
} from '../internal-link-helpers';
import { getPageListCache } from '../page-list-cache';
import { createAssetContextMenuPlugin } from '../plugins/asset-context-menu';
import { isSafeNavigationUrl } from '../safe-navigation-url';
import { InternalLinkPropPanel } from './InternalLinkPropPanel';
import { isResolvedAssetHref, makeLinkResolutionAttrsComputer } from './link-resolution';
import { linkResolutionDecorationPlugin } from './link-resolution-decoration';
import { createMarkInteractionBridgePlugin, getCurrentMarkInfo } from './mark-interaction-bridge';

export interface InternalLinkOptions {
  docName: string;
}

export type LinkMarkAssetActivation =
  | { kind: 'not-asset' }
  | { kind: 'refused' }
  | { kind: 'asset'; url: string; ext: string; literal: boolean; projectRelPath: string };

export function resolveLinkMarkAssetActivation(params: {
  href: string;
  sourceForm: unknown;
  docName: string;
  classified: ReturnType<typeof classifyMarkdownHref>;
}): LinkMarkAssetActivation {
  const { href, sourceForm, docName, classified } = params;
  const hrefExt = extractAssetExtension(href);
  const isWikiEmbed = sourceForm === 'wikiembed';
  if (classified?.kind !== 'asset' && !(isWikiEmbed && hrefExt !== null)) {
    return { kind: 'not-asset' };
  }
  const url = classified?.kind === 'asset' ? classified.url : href;
  const ext = classified?.kind === 'asset' ? classified.ext : (hrefExt ?? '');
  const literal = isWikiEmbed;
  const projectRelPath = resolveAssetProjectPath(url, docName, { literal });
  if (!projectRelPath) return { kind: 'refused' };
  return { kind: 'asset', url, ext, literal, projectRelPath };
}

export const InternalLink = LinkFidelity.extend<InternalLinkOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      docName: '',
    };
  },

  renderHTML({ HTMLAttributes }) {
    const href = typeof HTMLAttributes.href === 'string' ? HTMLAttributes.href : '';
    const ariaLabel = href ? `Link: ${href}` : 'Link';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-link': '',
        role: 'link',
        tabindex: '0',
        'aria-label': ariaLabel,
        style: 'touch-action: manipulation;',
      }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    const docName = this.options.docName ?? '';
    const handlePrimary = ({
      editor,
      nodeId,
      newTab,
    }: {
      editor: Editor;
      nodeId: string;
      newTab: boolean;
    }): boolean => {
      const info = getCurrentMarkInfo(editor.state, nodeId);
      const href = info?.attrs?.href;
      if (typeof href !== 'string' || !href) return false;

      const target = classifyMarkdownHref(href, docName);
      const activation = resolveLinkMarkAssetActivation({
        href,
        sourceForm: info?.attrs?.sourceForm,
        docName,
        classified: target,
      });
      if (activation.kind === 'refused') return false;
      if (activation.kind === 'asset') {
        const { url, ext, literal, projectRelPath } = activation;
        const cache = getPageListCache();
        if (cache === null) return false;
        if (cache.assetPaths !== undefined || cache.filePaths !== undefined) {
          if (!isResolvedAssetHref(url, docName, cache.assetPaths, cache.filePaths, { literal })) {
            return false;
          }
        }
        activateAssetLink({
          url,
          projectRelPath,
          ext,
          title: projectRelPath.split('/').pop() ?? url,
          newTab,
        });
        return true;
      }

      if (!target) return false;

      switch (target.kind) {
        case 'asset':
          return false;
        case 'doc': {
          const cache = getPageListCache();
          const intent = resolveLinkTargetIntent(target.docName, {
            pages: cache?.pages ?? new Set<string>(),
            folderPaths: cache?.folderPaths ?? new Set<string>(),
          });
          if (intent.kind === 'create') return false;
          if (newTab) {
            openInternalHashHrefInNewTab({ docName: target.docName, anchor: target.anchor });
          } else {
            window.location.assign(
              toInternalHashHref({ docName: target.docName, anchor: target.anchor }),
            );
          }
          return true;
        }
        case 'anchor':
          if (newTab) {
            openInternalHashHrefInNewTab({ docName, anchor: target.anchor });
          } else {
            window.location.assign(toInternalHashHref({ docName, anchor: target.anchor }));
          }
          return true;
        case 'external':
          if (!isSafeNavigationUrl(target.url)) return false;
          openExternalUrl(target.url);
          return true;
        default:
          return assertNeverLinkTarget(target);
      }
    };
    return [
      createMarkInteractionBridgePlugin({
        editor: this.editor,
        markTypes: ['link'],
        renderPropPanel: ({ editor, nodeId, deactivate }) =>
          createElement(InternalLinkPropPanel, {
            editor,
            nodeId,
            sourceDocName: docName,
            onClose: deactivate,
            onNavigate: (newTab: boolean) => handlePrimary({ editor, nodeId, newTab }),
          }),
        handlePrimary,
      }),
      linkResolutionDecorationPlugin({
        markTypes: ['link'],
        computeAttrs: makeLinkResolutionAttrsComputer(docName),
      }),
      createAssetContextMenuPlugin({ sourceDocName: docName }),
    ];
  },
});
