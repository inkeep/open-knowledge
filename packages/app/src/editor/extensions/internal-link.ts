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
import { resolveLinkTargetIntent } from '../../components/link-target-intent';
import {
  activateAssetLink,
  openHashHrefInNewTab,
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
  /** Active document name — used by link-resolution decoration to compute resolved/folder/unresolved states. */
  docName: string;
}

export const InternalLink = LinkFidelity.extend<InternalLinkOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      docName: '',
    };
  },

  renderHTML({ HTMLAttributes }) {
    // Plain-DOM chip — a single <span> with link text inline. We deliberately
    // omit the `<a href>` child that the React MarkView wrapped its
    // text in: clicking an `<a>` navigates immediately, which races the
    // InteractionLayer's pointerdown handler. Cmd/Ctrl+Click semantics live
    // in the extension's `handlePrimary` hook below — see file-header
    // comment for the full rationale.
    //
    // Accessibility:
    //   - `tabindex="0"` makes the chip keyboard-reachable.
    //   - `role="link"` matches the semantic intent.
    //   - `aria-label` surfaces the destination to assistive tech
    //     (falls back to "Link" when href is missing).
    //
    // The decoration plugins add data-mark-id (mark-identity-decoration)
    // and data-resolution-state (link-resolution-decoration) at render
    // time; CSS in globals.css styles the chip based on the latter. The
    // original href stays in the link mark's attrs (read by PropPanel +
    // handlePrimary for navigate/edit) — it's just not rendered as a
    // navigable element.
    const href = typeof HTMLAttributes.href === 'string' ? HTMLAttributes.href : '';
    const ariaLabel = href ? `Link: ${href}` : 'Link';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-link': '',
        role: 'link',
        tabindex: '0',
        'aria-label': ariaLabel,
        // touch-action: manipulation eliminates the iOS 300ms tap delay.
        style: 'touch-action: manipulation;',
      }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    const docName = this.options.docName ?? '';
    // Single source for chip primary-navigation. Referenced by both the
    // InteractionLayer (bare / Cmd / middle-click + Enter on the chip) and the
    // PropPanel's clickable destination text (via `onNavigate`) so the two
    // never drift on resolution / asset-dispatch / safe-scheme behavior.
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

      // Asset activation branch. Fires on BOTH bare click AND
      // Cmd/Ctrl+click — asset hrefs never open the PropPanel. Bare click
      // navigates to the in-app asset preview (sidebar parity); Cmd+click
      // forces OS delegation as an escape hatch (see `activateAssetLink`).
      //
      // Two paths enter this branch:
      //   1. `classifyMarkdownHref` returned `kind: 'asset'`.
      //   2. `sourceForm === 'wikiembed'` + the href shape looks
      //      asset-like — post-roundtrip `![[file.ext]]` emits as
      //      content-root-relative paths (`/file.ext`); `sourceForm`
      //      disambiguates those embedded asset references.
      const sourceForm = info?.attrs?.sourceForm;
      const target = classifyMarkdownHref(href, docName);
      const hrefExt = extractAssetExtension(href);
      const isAssetShape =
        target?.kind === 'asset' || (sourceForm === 'wikiembed' && hrefExt !== null);
      if (isAssetShape) {
        const url = target?.kind === 'asset' ? target.url : href;
        const ext = target?.kind === 'asset' ? target.ext : (hrefExt ?? '');
        const projectRelPath = resolveAssetProjectPath(url, docName);
        if (!projectRelPath) {
          // Path-escape — surface the suspicious href in the PropPanel
          // instead of dispatching to OS. `openAssetSafely` in the main
          // process is the defense-in-depth backstop.
          return false;
        }
        const cache = getPageListCache();
        if (cache === null) return false;
        // BOTH partitions participate in the existence
        // check. A markdown link to a tracked non-markdown file (kind:'file'
        // — e.g. `[csv](./data/example.csv)`) must navigate, not bail. The
        // optimistic-when-both-missing branch keeps very-cold-cache behavior
        // unchanged so we don't refuse to navigate before the first
        // /api/documents lands.
        if (cache.assetPaths !== undefined || cache.filePaths !== undefined) {
          if (!isResolvedAssetHref(url, docName, cache.assetPaths, cache.filePaths)) {
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

      // `target.kind === 'asset'` is excluded by the isAssetShape
      // early-return above, so TypeScript narrows `target` to doc /
      // anchor / external here.
      switch (target.kind) {
        case 'doc': {
          // Unresolved docs (target page missing OR a folder with no
          // index) fall through so the popover surfaces "Create page" /
          // "Create index" — the only useful action when there's no
          // destination to navigate to.
          const cache = getPageListCache();
          const intent = resolveLinkTargetIntent(target.docName, {
            pages: cache?.pages ?? new Set<string>(),
            folderPaths: cache?.folderPaths ?? new Set<string>(),
          });
          if (intent.kind === 'create') return false;
          if (intent.kind === 'navigate' && intent.displayState === 'folder') return false;
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
          // Anchor lives inside the current doc — same-tab on bare click,
          // new-tab via the hash-href helper on Cmd-click.
          if (newTab) {
            openInternalHashHrefInNewTab({ docName, anchor: target.anchor });
          } else {
            window.location.assign(toInternalHashHref({ docName, anchor: target.anchor }));
          }
          return true;
        case 'external':
          // Refuse javascript:/data:/etc via scheme allowlist.
          // Fall through if unsafe so the PropPanel surfaces the URL for
          // the author to edit. External links ALWAYS open in a new tab —
          // bare-click on cross-origin content shouldn't navigate away
          // from the editor (both branches end up calling
          // `openHashHrefInNewTab`, just routed for symmetry with the
          // doc/anchor branches above).
          if (!isSafeNavigationUrl(target.url)) return false;
          openHashHrefInNewTab(target.url);
          return true;
        default:
          return assertNeverLinkTarget(target);
      }
    };
    return [
      // 1. mark-identity (PluginState IDs) + InteractionLayer wiring + Cmd+Click new-tab
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
      // 2. Merged decoration plugin: one PM plugin walking
      //    markIdentityKey.byId once and emitting one Decoration.inline
      //    per matching mark with BOTH `data-mark-id` (so InteractionLayer
      //    event delegation resolves chips → mark IDs) AND any caller-computed
      //    resolution-state attrs (so chip CSS styles by resolved/folder/
      //    unresolved/loading/external/anchor). Replaces the prior pair of
      //    stacked plugins (markIdentityDecorationPlugin +
      //    linkResolutionDecorationPlugin) — halves the per-link wrapper-span
      //    count.
      linkResolutionDecorationPlugin({
        markTypes: ['link'],
        computeAttrs: makeLinkResolutionAttrsComputer(docName),
      }),
      // 4. Right-click context menu for on-disk references. Attaches
      //    a `contextmenu` DOM listener on `editor.view.dom` and
      //    routes matched targets
      //    (wiki-embed chips, asset link marks, images) through the
      //    showAssetMenu IPC. No-op in web (browser default).
      createAssetContextMenuPlugin({ sourceDocName: docName }),
    ];
  },
});
