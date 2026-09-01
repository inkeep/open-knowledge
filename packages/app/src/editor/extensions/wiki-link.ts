import { WikiLink as BaseWikiLink, resolveWikiLinkTarget } from '@inkeep/open-knowledge-core';
import { createElement } from 'react';
import { openExternalUrl } from '@/lib/external-link';
import { resolveLinkTargetIntent } from '../../components/link-target-intent';
import { type ResolvedPageIcon, resolvePageIcon } from '../../components/page-header-utils';
import { hashFromAssetPath } from '../../lib/doc-hash';
import { getInteractionLayer } from '../interaction-layer-host';
import {
  openHashHrefInNewTab,
  openInternalHashHrefInNewTab,
  toInternalHashHref,
} from '../internal-link-helpers';
import {
  isLinkValidationVisible,
  subscribeToLinkValidationPolicy,
} from '../link-validation-policy';
import {
  getPageListCache,
  type PageListCacheSnapshot,
  subscribePageListCache,
} from '../page-list-cache';
import { isSafeNavigationUrl } from '../safe-navigation-url';
import { WikiLinkPropPanel } from './WikiLinkPropPanel';
import {
  getWikiLinkResolutionCandidates,
  resolveWikiLinkAssetTarget,
  resolveWikiLinkTargetDocName,
} from './wiki-link-helpers';
import { configureWikiLinkSuggestion, wikiLinkSuggestionKey } from './wiki-link-suggestion';

let __wikiLinkNodeIdCounter = 0;

function nextWikiLinkNodeId(): string {
  return `wiki-link-${++__wikiLinkNodeIdCounter}`;
}

function __resetWikiLinkNodeIdCounterForTests(): void {
  __wikiLinkNodeIdCounter = 0;
}

interface BuildChipDomResult {
  dom: HTMLElement;
  iconSpan: HTMLElement;
}

function buildWikiLinkChipDom(params: {
  nodeId: string;
  target: string;
  alias: string | null;
  anchor: string | null;
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

  const dom = docImpl.createElement('span') as HTMLElement;
  dom.setAttribute('data-wiki-link', '');
  dom.setAttribute('data-node-id', params.nodeId);
  dom.setAttribute('data-target', params.target);
  dom.setAttribute('data-alias', params.alias ?? '');
  dom.setAttribute('data-anchor', params.anchor ?? '');
  dom.setAttribute('contenteditable', 'false');
  dom.setAttribute('role', 'button');
  dom.setAttribute('tabindex', '0');
  dom.setAttribute(
    'aria-label',
    `Wiki link: ${params.target}${params.anchor ? `#${params.anchor}` : ''}`,
  );
  dom.classList.add('wiki-link-chip');
  dom.style.touchAction = 'manipulation';

  const iconSpan = docImpl.createElement('span') as HTMLElement;
  iconSpan.setAttribute('data-wiki-link-icon', '');
  iconSpan.setAttribute('aria-hidden', 'true');
  dom.appendChild(iconSpan);

  const labelText = params.alias ?? `${params.target}${params.anchor ? `#${params.anchor}` : ''}`;
  const labelNode = docImpl.createTextNode(labelText);
  dom.appendChild(labelNode);

  return { dom, iconSpan };
}

export function getWikiLinkIcon(
  target: string,
  cache: PageListCacheSnapshot | null,
): ResolvedPageIcon | null {
  if (!cache || !target) return null;
  const docName = resolveWikiLinkTargetDocName(target, cache);
  if (!docName) return null;
  const rawIcon = cache.pageIcons?.get(docName);
  if (!rawIcon) return null;
  const resolved = resolvePageIcon(rawIcon);
  if (resolved.kind === 'unsupported') return null;
  return resolved;
}

export function getWikiLinkResolutionState(
  target: string,
  anchor: string | null,
  cache: PageListCacheSnapshot | null,
): string | null {
  if (!target) return null;
  const classified = resolveWikiLinkTarget(target, anchor, cache ?? new Set<string>());
  if (!classified) return null;
  if (classified.kind === 'external') return 'external';
  if (!cache) return 'loading';
  if (classified.kind === 'asset') {
    if (cache.assetPaths === undefined && cache.filePaths === undefined) return 'asset';
    return resolveWikiLinkAssetTarget(
      classified.url,
      cache.assetPaths ?? new Set(),
      cache.filePaths,
    )
      ? 'asset'
      : isLinkValidationVisible()
        ? 'unresolved'
        : null;
  }
  const intent = resolveLinkTargetIntent(target, {
    pages: cache.pages,
    folderPaths: cache.folderPaths,
    pagesBySlug: cache.pagesBySlug,
    pagesByBasename: cache.pagesByBasename,
    fallbackTargets: getWikiLinkResolutionCandidates(target),
  });
  if (intent.kind !== 'create') return intent.displayState;
  return isLinkValidationVisible() ? 'unresolved' : null;
}

function syncWikiLinkResolutionState(dom: HTMLElement, state: string | null): void {
  const next = state ?? '';
  if (dom.getAttribute('data-resolution-state') === next) return;
  if (!next) {
    dom.removeAttribute('data-resolution-state');
    return;
  }
  dom.setAttribute('data-resolution-state', next);
}

export function syncWikiLinkIconSlot(
  iconSpan: HTMLElement,
  icon: ResolvedPageIcon | null,
  docImpl: Pick<Document, 'createElement' | 'createTextNode'> = document,
): void {
  const nextKind = icon?.kind ?? '';
  const nextValue = icon?.value ?? '';
  if (
    iconSpan.getAttribute('data-kind') === nextKind &&
    iconSpan.getAttribute('data-value') === nextValue
  ) {
    return;
  }
  iconSpan.setAttribute('data-kind', nextKind);
  iconSpan.setAttribute('data-value', nextValue);
  while (iconSpan.firstChild) iconSpan.removeChild(iconSpan.firstChild);
  if (!icon) return;
  if (icon.kind === 'emoji') {
    iconSpan.appendChild(docImpl.createTextNode(icon.value));
    return;
  }
  const img = docImpl.createElement('img') as HTMLImageElement;
  img.setAttribute('src', icon.value);
  img.setAttribute('alt', '');
  img.setAttribute('draggable', 'false');
  img.setAttribute('referrerpolicy', 'no-referrer');
  iconSpan.appendChild(img);
}

export const WikiLink = BaseWikiLink.extend<{ docName: string }>({
  priority: 200,

  addOptions() {
    return {
      ...this.parent?.(),
      docName: '',
    };
  },

  addNodeView() {
    return ({ editor, node, getPos }) => {
      const nodeId = nextWikiLinkNodeId();
      const target = String(node.attrs.target ?? '');
      const alias = node.attrs.alias != null ? String(node.attrs.alias) : null;
      const anchor = node.attrs.anchor != null ? String(node.attrs.anchor) : null;
      const { dom, iconSpan } = buildWikiLinkChipDom({ nodeId, target, alias, anchor });

      let currentNode = node;

      const refreshIconSlot = () => {
        const liveTarget = String(currentNode.attrs.target ?? '');
        const liveAnchor =
          currentNode.attrs.anchor != null ? String(currentNode.attrs.anchor) : null;
        const snapshot = getPageListCache();
        syncWikiLinkIconSlot(iconSpan, getWikiLinkIcon(liveTarget, snapshot));
        syncWikiLinkResolutionState(
          dom,
          getWikiLinkResolutionState(liveTarget, liveAnchor, snapshot),
        );
      };
      refreshIconSlot();
      const unsubscribePageListCache = subscribePageListCache(refreshIconSlot);
      const unsubscribePolicy = subscribeToLinkValidationPolicy(refreshIconSlot);

      const safeGetPos = (): number | undefined => {
        const pos = getPos();
        return typeof pos === 'number' ? pos : undefined;
      };

      const layer = getInteractionLayer(editor);
      const handlePrimary = ({ newTab }: { newTab: boolean }): boolean => {
        const live = currentNode.attrs;
        const liveTarget = typeof live.target === 'string' ? live.target : '';
        if (!liveTarget) return false;
        const liveAnchor = typeof live.anchor === 'string' ? live.anchor : null;
        const cache = getPageListCache();
        const classified = resolveWikiLinkTarget(
          liveTarget,
          liveAnchor,
          cache ?? new Set<string>(),
        );
        if (!classified) return false;
        if (classified.kind === 'doc') {
          const intent = resolveLinkTargetIntent(liveTarget, {
            pages: cache?.pages ?? new Set<string>(),
            folderPaths: cache?.folderPaths ?? new Set<string>(),
            pagesBySlug: cache?.pagesBySlug,
            pagesByBasename: cache?.pagesByBasename,
            fallbackTargets: getWikiLinkResolutionCandidates(liveTarget),
          });
          if (intent.kind === 'create') return false;
          const targetDocName =
            intent.kind === 'navigate' ? intent.hashDocName : classified.docName;
          if (newTab) {
            openInternalHashHrefInNewTab({
              docName: targetDocName,
              anchor: classified.anchor,
            });
          } else {
            window.location.assign(
              toInternalHashHref({ docName: targetDocName, anchor: classified.anchor }),
            );
          }
          return true;
        }
        if (classified.kind === 'asset') {
          const assetPath =
            resolveWikiLinkAssetTarget(
              classified.url,
              cache?.assetPaths ?? new Set<string>(),
              cache?.filePaths,
            ) ?? classified.url.replace(/^\//, '');
          if (newTab) {
            openHashHrefInNewTab(hashFromAssetPath(assetPath));
          } else {
            window.location.hash = hashFromAssetPath(assetPath);
          }
          return true;
        }
        if (!isSafeNavigationUrl(classified.url)) return false;
        openExternalUrl(classified.url);
        return true;
      };
      layer.register({
        type: 'wikiLink',
        nodeId,
        getPos: safeGetPos,
        controls: {
          propPanel: (ctx) =>
            createElement(WikiLinkPropPanel, {
              editor,
              getPos: safeGetPos,
              onClose: ctx.deactivate,
              onNavigate: (newTab: boolean) => handlePrimary({ newTab }),
            }),
        },
        handlePrimary,
      });

      return {
        dom,
        ignoreMutation: () => true,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'wikiLink') return false;
          currentNode = updatedNode;
          const newTarget = String(updatedNode.attrs.target ?? '');
          const newAlias = updatedNode.attrs.alias != null ? String(updatedNode.attrs.alias) : null;
          const newAnchor =
            updatedNode.attrs.anchor != null ? String(updatedNode.attrs.anchor) : null;
          dom.setAttribute('data-target', newTarget);
          dom.setAttribute('data-alias', newAlias ?? '');
          dom.setAttribute('data-anchor', newAnchor ?? '');
          dom.setAttribute(
            'aria-label',
            `Wiki link: ${newTarget}${newAnchor ? `#${newAnchor}` : ''}`,
          );
          const labelText = newAlias ?? `${newTarget}${newAnchor ? `#${newAnchor}` : ''}`;
          const lastChild = dom.lastChild;
          if (lastChild && lastChild.nodeType === 3) {
            lastChild.nodeValue = labelText;
          } else {
            dom.appendChild(dom.ownerDocument.createTextNode(labelText));
          }
          refreshIconSlot();
          return true;
        },
        destroy: () => {
          layer.deregister(nodeId);
          unsubscribePageListCache();
          unsubscribePolicy();
        },
      };
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        // WARN: Reads @tiptap/suggestion internal state — verify shape on upgrades.
        const pluginState = wikiLinkSuggestionKey.getState(this.editor.state) as
          | { active: boolean }
          | undefined;
        if (pluginState?.active) return false;

        const { selection } = this.editor.state;
        if (!selection.empty) return false;

        const nodeBefore = selection.$from.nodeBefore;
        if (nodeBefore?.type.name === 'wikiLink') {
          const { state, view } = this.editor;
          view.dispatch(state.tr.delete(selection.from - nodeBefore.nodeSize, selection.from));
          return true;
        }
        return false;
      },
      Delete: () => {
        const pluginState = wikiLinkSuggestionKey.getState(this.editor.state) as
          | { active: boolean }
          | undefined;
        if (pluginState?.active) return false;

        const { selection } = this.editor.state;
        if (!selection.empty) return false;

        const nodeAfter = selection.$from.nodeAfter;
        if (nodeAfter?.type.name === 'wikiLink') {
          const { state, view } = this.editor;
          view.dispatch(state.tr.delete(selection.from, selection.from + nodeAfter.nodeSize));
          return true;
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    return [configureWikiLinkSuggestion(this.editor)];
  },
});
