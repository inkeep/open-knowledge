/**
 * App-specific WikiLink extension — plain-DOM NodeView routed via the
 * shared InteractionLayer.
 *
 * An imperative plain-DOM NodeView mirrors the RawMdxFallback pattern —
 * chip rendered as pure DOM with `data-node-id` for InteractionLayer
 * event delegation, and a singleton `WikiLinkPropPanel` mounts at editor
 * root on activation.
 *
 * WikiLink is an atom node (no inline content). Stable identity comes from
 * a per-NodeView monotonic counter (`wiki-link-${++counter}`) — there is
 * no mark-identity equivalent for atom nodes. This is symmetric to the
 * RawMdxFallback `nextRawMdxNodeId` pattern.
 *
 * The `+ [[` suggestion plugin (`configureWikiLinkSuggestion`) and the
 * Backspace/Delete keyboard shortcuts that trigger atom-deletion when the
 * wikiLink suggestion popover is closed remain orthogonal to the chip
 * rendering.
 */
import { WikiLink as BaseWikiLink, classifyWikiLinkTarget } from '@inkeep/open-knowledge-core';
import { createElement } from 'react';
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

// Module-level monotonic counter — drives the stable `data-node-id` attribute
// used by InteractionLayer's event delegation. Mirrors the
// `nextRawMdxNodeId` pattern.
let __wikiLinkNodeIdCounter = 0;

/**
 * Allocate a fresh stable node id for a WikiLink NodeView instance.
 * Exported for monotonicity testing.
 */
function nextWikiLinkNodeId(): string {
  return `wiki-link-${++__wikiLinkNodeIdCounter}`;
}

/** Reset the counter. Test-only. */
function __resetWikiLinkNodeIdCounterForTests(): void {
  __wikiLinkNodeIdCounter = 0;
}

interface BuildChipDomResult {
  dom: HTMLElement;
  iconSpan: HTMLElement;
}

/**
 * Build the plain-DOM chip structure for a WikiLink NodeView.
 *
 * Exported for unit testing — the DOM layout (attributes, class list) can be
 * exercised without constructing a full TipTap Editor.
 */
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
  // touch-action: manipulation eliminates iOS 300ms tap delay.
  dom.style.touchAction = 'manipulation';

  // Icon prefix slot — always present, content owned by the
  // `syncIconSpan` helper invoked from the NodeView's cache subscriber.
  // Pre-allocated here (rather than on first icon-resolve) so the chip
  // DOM shape is stable, which keeps the InteractionLayer event
  // delegation + label-text indexing trivial. Empty slot collapses to
  // zero width via CSS `:empty` selector — no layout cost when the
  // target has no icon. aria-hidden because the chip's aria-label
  // already announces the link target; the icon is decorative chrome.
  const iconSpan = docImpl.createElement('span') as HTMLElement;
  iconSpan.setAttribute('data-wiki-link-icon', '');
  iconSpan.setAttribute('aria-hidden', 'true');
  dom.appendChild(iconSpan);

  // Visible label — text content of the chip.
  const labelText = params.alias ?? `${params.target}${params.anchor ? `#${params.anchor}` : ''}`;
  const labelNode = docImpl.createTextNode(labelText);
  dom.appendChild(labelNode);

  return { dom, iconSpan };
}

/**
 * Pure helper — given a wiki-link `target` and the current page-list
 * cache snapshot, return the icon's resolved kind/value or `null` when
 * no icon should render. Exported for unit testing.
 *
 * Returns `null` for non-doc targets (assets, external URLs, anchor-
 * only) — only doc-shaped wiki-links surface an icon prefix, mirroring
 * the principle that the icon represents "the page being linked to".
 */
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

/**
 * Mutate the icon slot in-place to match `icon`. Idempotent — re-running
 * with the same `(kind, value)` is a no-op (cheap equality check on the
 * data attrs before any DOM writes). Clears the slot when `icon` is
 * null so docs that lose their `icon:` frontmatter shed the chip
 * prefix without a NodeView remount.
 */
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
  // `url` / `path` — img element. `path` is already
  // `toDesktopAssetHref`-wrapped by `resolvePageIcon`.
  const img = docImpl.createElement('img') as HTMLImageElement;
  img.setAttribute('src', icon.value);
  img.setAttribute('alt', '');
  img.setAttribute('draggable', 'false');
  // External-host icons (`url` kind) leak Referer without this.
  // Mirrors `Embed` / `CodeBlockView` / `Image` / `PageHeader` posture.
  img.setAttribute('referrerpolicy', 'no-referrer');
  iconSpan.appendChild(img);
}

export const WikiLink = BaseWikiLink.extend<{ docName: string }>({
  // Higher priority ensures the suggestion plugin's handleKeyDown fires before
  // TipTap's base keymap (Enter → split block, Backspace → joinBackward), so
  // Enter completes a suggestion and Backspace/Delete can target adjacent atoms.
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

      // Reassigned on every `update(newNode)` call — PM's NodeView contract
      // passes a fresh node object to `update`, but the factory-closure
      // `node` argument is NOT rebound. `handlePrimary` reads
      // `currentNode.attrs` so PropPanel edits flow through to the
      // Cmd/Ctrl+click destination without a full NodeView recreate.
      // Pre-fix, editing a wiki-link's target
      // via the PropPanel Save button correctly updated the visible chip
      // DOM (via the `update` hook below) but left the closure's `node`
      // variable pointing at the ORIGINAL attrs — Cmd+click then opened
      // the pre-edit target.
      let currentNode = node;

      // Repaint the chip's icon slot from the page-list cache. Called
      // (a) once at NodeView creation, (b) on every page-list cache
      // change (subscriber below — covers icon-frontmatter edits on
      // the LINKED page even when the link's own attrs are unchanged),
      // and (c) on `update` (covers PropPanel target swaps that point
      // the link at a different page). `syncWikiLinkIconSlot`
      // short-circuits on attr-equality so identical resolves cost
      // a single attr comparison, no DOM writes.
      const refreshIconSlot = () => {
        const liveTarget = String(currentNode.attrs.target ?? '');
        const icon = getWikiLinkIcon(liveTarget, getPageListCache());
        syncWikiLinkIconSlot(iconSpan, icon);
      };
      refreshIconSlot();
      const unsubscribePageListCache = subscribePageListCache(refreshIconSlot);

      const safeGetPos = (): number | undefined => {
        const pos = getPos();
        return typeof pos === 'number' ? pos : undefined;
      };

      const layer = getInteractionLayer(editor);
      // Bare click navigates to the target (doc/anchor same-tab, external
      // always new-tab, asset same-tab). Cmd/Ctrl/middle-click forces
      // new-tab. Unresolved doc targets (page missing or folder with no
      // index) return false so the popover surfaces "Create page" / "Create
      // index" — the only useful action when there's nothing to navigate
      // to. Reads `currentNode.attrs` (reassigned by the `update` hook
      // below on PropPanel edits).
      //
      // Single source for primary-navigation: both the InteractionLayer
      // (chip click / Enter) and the PropPanel's clickable destination text
      // (via `onNavigate`) call this, so they never drift.
      const handlePrimary = ({ newTab }: { newTab: boolean }): boolean => {
        const live = currentNode.attrs;
        const liveTarget = typeof live.target === 'string' ? live.target : '';
        if (!liveTarget) return false;
        const liveAnchor = typeof live.anchor === 'string' ? live.anchor : null;
        const classified = classifyWikiLinkTarget(liveTarget, liveAnchor);
        if (!classified) return false;
        if (classified.kind === 'doc') {
          const cache = getPageListCache();
          const intent = resolveLinkTargetIntent(liveTarget, {
            pages: cache?.pages ?? new Set<string>(),
            folderPaths: cache?.folderPaths ?? new Set<string>(),
            pagesBySlug: cache?.pagesBySlug,
            pagesByBasename: cache?.pagesByBasename,
            fallbackTargets: getWikiLinkResolutionCandidates(liveTarget),
          });
          if (intent.kind === 'create') return false;
          if (intent.kind === 'navigate' && intent.displayState === 'folder') return false;
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
          // Also consult `filePaths` (tracked non-markdown
          // files surfaced by /api/documents as `kind:'file'`). Without it a
          // wiki-link to a tracked non-asset file would resolve to the bare
          // `classified.url.replace(/^\//, '')` and the chip would render as
          // unresolved — even though the file IS tracked.
          const cache = getPageListCache();
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
        // external — refuse unsafe schemes. Always
        // open in a new tab regardless of bare-click vs Cmd-click.
        if (!isSafeNavigationUrl(classified.url)) return false;
        openHashHrefInNewTab(classified.url);
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
          // Atom node — only attrs change. Mirror updates back into the chip
          // DOM so external attr changes (e.g. PropPanel's setNodeMarkup)
          // refresh the visible label without re-creating the NodeView.
          if (updatedNode.type.name !== 'wikiLink') return false;
          // Reassign currentNode BEFORE the DOM writes so any synchronous
          // observer that reads it (unlikely in current code, but cheap
          // safety) sees consistent state.
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
          // `dom.textContent = ...` would blow away the iconSpan child
          // along with the prior label text. Walk children and update
          // only the trailing text node (label always lives last per
          // `buildWikiLinkChipDom`'s append order), preserving the
          // icon slot.
          const lastChild = dom.lastChild;
          if (lastChild && lastChild.nodeType === 3 /* TEXT_NODE */) {
            lastChild.nodeValue = labelText;
          } else {
            dom.appendChild(dom.ownerDocument.createTextNode(labelText));
          }
          // Target may have changed → icon may have changed. Refresh
          // from the cache before returning. The subscriber-fired
          // refresh also handles this, but the synchronous path keeps
          // the chip visually consistent on the same tick as the
          // attribute mutation.
          refreshIconSlot();
          return true;
        },
        destroy: () => {
          layer.deregister(nodeId);
          unsubscribePageListCache();
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
