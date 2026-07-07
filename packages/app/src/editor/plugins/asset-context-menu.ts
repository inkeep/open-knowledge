/**
 * Renderer-side right-click context menu for on-disk references.
 *
 * When the user right-clicks an `<a data-wiki-embed>` (drop-time wiki-embed
 * chip), an `<a>` with a `link` mark (post-roundtrip asset chip or markdown
 * hand-authored link), an `<a data-wiki-link>` (doc-to-doc wiki-link chip),
 * or an `<img>` with an asset src — this plugin resolves the click target,
 * classifies the kind, and invokes `window.okDesktop.shell.showAssetMenu`.
 * Main-process `popAssetMenu` builds the native menu and pops it on the
 * caller window.
 *
 * In web (no `window.okDesktop`), the plugin is a no-op — the browser's
 * default context menu surfaces. Docmost/SilverBullet/HedgeDoc let
 * Chromium handle context menus too because there's no file manager to
 * Reveal into anyway.
 *
 * Pure: walks DOM only, no React imports, no TipTap internals. Tests
 * exercise `classifyContextMenuTarget` against fake DOM elements.
 */

import { classifyMarkdownHref, resolveAssetProjectPath } from '@inkeep/open-knowledge-core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** What kind of on-disk reference the user right-clicked on. */
type ContextMenuTargetKind = 'asset' | 'wiki-link' | 'image';

interface ContextMenuTarget {
  readonly kind: ContextMenuTargetKind;
  /** Project-root-relative path — `shell.showItemInFolder` + `shell.openPath` input. */
  readonly relPath: string;
  /** User-facing label for the menu (basename of the asset). */
  readonly title: string;
}

/**
 * Walk a click target up to the nearest on-disk reference anchor and
 * resolve its project-relative path. Returns `null` if the click wasn't
 * on a recognized reference (the native menu takes over).
 *
 * The resolution uses the `sourceDocName` (editor's current doc) to walk
 * relative paths via `resolveAssetProjectPath`. This mirrors the same
 * path the left-click dispatcher uses, so Reveal/Open in the context
 * menu points at the exact file the user would reach via a bare click.
 */
export function classifyContextMenuTarget(
  element: Element,
  sourceDocName: string,
): ContextMenuTarget | null {
  // Walk up looking for the nearest matching ancestor. Arbitrary depth
  // because chips may be wrapped in spans / decoration divs. Duck-typed
  // on `hasAttribute` + `tagName` so unit tests can exercise this with
  // plain-object fixtures (bun test runs in Node without a DOM).
  let cur: Element | null = element;
  while (cur && typeof cur.hasAttribute === 'function') {
    // 1. wiki-embed drop-time chip (`<a data-wiki-embed>` or `<img data-wiki-embed>`)
    if (cur.hasAttribute('data-wiki-embed')) {
      const target = cur.getAttribute('data-target') ?? '';
      if (!target) return null;
      const relPath = resolveAssetProjectPath(target, sourceDocName);
      if (!relPath) return null;
      const isImg = cur.tagName === 'IMG';
      return {
        kind: isImg ? 'image' : 'asset',
        relPath,
        title: relPath.split('/').pop() ?? target,
      };
    }
    // 2. wiki-link chip (`<span data-wiki-link>` or similar — doc-to-doc [[foo]])
    if (cur.hasAttribute('data-wiki-link')) {
      const target = cur.getAttribute('data-target') ?? '';
      if (!target) return null;
      // WikiLink targets are doc names; they resolve to <name>.md on disk.
      // The context menu offers Reveal + Open for that markdown file.
      return {
        kind: 'wiki-link',
        relPath: `${target}.md`,
        title: target,
      };
    }
    // 3. Plain `<a>` with a link mark — post-roundtrip asset chip OR
    //    hand-authored `[name](./file.pdf)`. We can only claim asset-
    //    classified hrefs (non-md/mdx extensions); doc-link hrefs to
    //    markdown stay on the default menu (they're wiki-link-shaped
    //    in the click flow but via href not data-target here).
    if (cur.tagName === 'A' && cur.hasAttribute('href')) {
      const href = cur.getAttribute('href') ?? '';
      const classified = classifyMarkdownHref(href, sourceDocName);
      if (classified?.kind === 'asset') {
        const relPath = resolveAssetProjectPath(classified.url, sourceDocName);
        if (!relPath) return null;
        return {
          kind: 'asset',
          relPath,
          title: relPath.split('/').pop() ?? classified.url,
        };
      }
      // Non-asset `<a>` — fall through (walker continues in case the
      // anchor is nested inside an on-disk-ref container).
    }
    // 4. Inline `<img>` with an asset src. Some images may not have
    //    data-wiki-embed (e.g. server-side mdast→PM converts `![[x.png]]`
    //    to a plain PM image node). Match on a project-relative src.
    if (cur.tagName === 'IMG') {
      const src = cur.getAttribute('src') ?? '';
      if (src) {
        const classified = classifyMarkdownHref(src, sourceDocName);
        if (classified?.kind === 'asset') {
          const relPath = resolveAssetProjectPath(classified.url, sourceDocName);
          if (!relPath) return null;
          return {
            kind: 'image',
            relPath,
            title: relPath.split('/').pop() ?? classified.url,
          };
        }
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

const assetContextMenuKey = new PluginKey('asset-context-menu');

interface AssetContextMenuPluginOpts {
  /** Source doc for resolving relative paths. Captured at plugin-factory time. */
  readonly sourceDocName: string;
  /** Test seam — defaults to `window.okDesktop?.shell.showAssetMenu`. */
  readonly showAssetMenu?: (params: ContextMenuTarget) => Promise<void>;
}

export function createAssetContextMenuPlugin(opts: AssetContextMenuPluginOpts): Plugin {
  return new Plugin({
    key: assetContextMenuKey,
    view(editorView: EditorView) {
      const showAssetMenu =
        opts.showAssetMenu ??
        ((params) => {
          const bridge = globalThis.window?.okDesktop;
          if (!bridge) {
            // Web — native browser menu takes over.
            return Promise.resolve();
          }
          return bridge.shell.showAssetMenu({
            relPath: params.relPath,
            title: params.title,
            kind: params.kind,
          });
        });

      const handler = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        const target = classifyContextMenuTarget(event.target, opts.sourceDocName);
        if (!target) return; // default menu for non-on-disk content
        event.preventDefault();
        void showAssetMenu(target);
      };

      editorView.dom.addEventListener('contextmenu', handler);
      return {
        destroy() {
          editorView.dom.removeEventListener('contextmenu', handler);
        },
      };
    },
  });
}
