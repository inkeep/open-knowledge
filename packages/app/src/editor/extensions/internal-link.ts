/** Schema unchanged (precedent #9 add-only). */
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
