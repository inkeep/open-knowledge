/**
 * WikiLinkEmbed PM node — client-insert-only intermediate for the
 * `![[file.ext]]` asset-embed construct.
 *
 * **Lifecycle:**
 *   1. User drops a file. `pickInsertShape(filename)` decides whether to
 *      emit a PM `wikiLinkEmbed` node (renderable extension in the
 *      `wikiEmbedExtensions` allowlist + `emitFormat='wikiembed'`).
 *   2. TipTap renders this node via the `renderHTML` below — image
 *      extensions become `<img>`, non-image wikiembed extensions become
 *      clickable `<a>` (plain-link fallback; a future typed-component-
 *      nodes phase will promote to Video/Audio/PDFViewer at read time).
 *   3. On save, `nodeHandlers.wikiLinkEmbed` (in `markdown/index.ts`)
 *      serializes the node back to `![[name.ext]]` mdast.
 *   4. On next doc reload, server-side Observer B parses Y.Text through
 *      `mdManager.parseWithFallback` — `handlers.wikiLinkEmbed` dispatches
 *      by extension to PM `image` (image-ext) or PM link-marked text
 *      (non-image wikiembed). Server-side mdast→PM NEVER emits a PM
 *      `wikiLinkEmbed` node post-round-trip.
 *
 * So this node is transient — it exists between drop and next round-trip.
 * Without it, the client would need to synthesize a PM image / link-
 * marked text at drop time, duplicating the handler dispatch logic.
 *
 * Attrs are serialized into DOM via `data-*` so TipTap's `parseHTML` can
 * round-trip through a re-mount. No `resolved` flag — the render path
 * dispatches on extension alone.
 */
import { Node } from '@tiptap/core';
import { IMAGE_EXTENSIONS } from '../constants/upload.ts';
import { extensionOf } from '../utils/extension.ts';
import { normalizeNullableString } from './wiki-link.ts';

export interface WikiLinkEmbedAttrs {
  target: string;
  alias: string | null;
  anchor: string | null;
  /**
   * Transient client-only render hint. When `pickInsertShape` inserts a
   * new embed at drop time it knows the server-resolved relative path
   * (from the upload response); storing that path here lets
   * `renderHTML` emit `<img src=<resolvedSrc>>` instead of the bare
   * target. Without this, a non-default `content.attachmentFolderPath`
   * (e.g. `attachments`) produces a broken inline preview between drop
   * and the next round-trip.
   *
   * NOT serialized to markdown (the dispatch `toMarkdown`
   * `nodeHandlers.wikiLinkEmbed` path uses target/alias/anchor only).
   * NOT emitted by the server's mdast→PM dispatch — on load, Observer B
   * converts `![[file.ext]]` to PM image/link with basename-index-
   * resolved `src`, so the subsequent render path doesn't need the
   * hint. Cleared to null when not known (opening an existing doc
   * client-side without the hint falls through to `target`).
   */
  resolvedSrc: string | null;
}

function labelFor(attrs: Pick<WikiLinkEmbedAttrs, 'target' | 'alias' | 'anchor'>): string {
  if (attrs.alias) return attrs.alias;
  return attrs.anchor ? `${attrs.target}#${attrs.anchor}` : attrs.target;
}

export const WikiLinkEmbed = Node.create({
  name: 'wikiLinkEmbed',
  group: 'inline',
  inline: true,
  atom: true,
  priority: 60,

  addAttributes() {
    return {
      target: { default: '' },
      alias: { default: null },
      anchor: { default: null },
      // `rendered: false` — the attr drives `<img src>`/`<a href>` at
      // render time but is NOT itself serialized into a DOM attribute,
      // and more importantly is NOT part of the markdown round-trip
      // (nodeHandlers.wikiLinkEmbed writes target/alias/anchor only).
      // `parseHTML: () => null` prevents an attacker-planted
      // `data-resolved-src` from leaking into the PM tree via paste.
      resolvedSrc: {
        default: null,
        rendered: false,
        parseHTML: () => null,
      },
    };
  },

  parseHTML() {
    // Match every tag `renderHTML` actually emits — <img> (image ext)
    // and <a> (non-image / opaque). Clipboard copy-and-paste of a
    // rendered embed reaches us as the rendered tag, so the matcher
    // must cover both shapes to round-trip the wikiembed attrs.
    // `priority: 100` wins over the standard Image / Link extensions
    // that would otherwise claim the node first (default priority 50).
    const getAttrs = (node: HTMLElement | string) => {
      if (typeof node === 'string') return false;
      if (!node.hasAttribute('data-wiki-embed')) return false;
      return {
        target: node.getAttribute('data-target') || '',
        alias: normalizeNullableString(node.getAttribute('data-alias')),
        anchor: normalizeNullableString(node.getAttribute('data-anchor')),
        // resolvedSrc intentionally NOT recovered from DOM: the attr is a
        // drop-time hint from the upload response, not part of the
        // stored shape. After parse, render falls back to `target` until
        // the server round-trip lands the basename-resolved src.
      };
    };
    return [
      { tag: 'img[data-wiki-embed]', getAttrs, priority: 100 },
      { tag: 'a[data-wiki-embed]', getAttrs, priority: 100 },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const target = String(node.attrs.target ?? '');
    const alias = normalizeNullableString(node.attrs.alias);
    const anchor = normalizeNullableString(node.attrs.anchor);
    const resolvedSrc = normalizeNullableString(node.attrs.resolvedSrc);
    const ext = extensionOf(target);

    // Image extension → inline <img>. `resolvedSrc` (drop-time hint from
    // the upload response) takes priority so non-default
    // `content.attachmentFolderPath` values render correctly. Otherwise
    // fall back to the bare target — the browser resolves it relative
    // to the current doc's URL, which is only correct for the default
    // `./` content.attachmentFolderPath. Server-side round-trip to PM image
    // node provides the authoritative resolution path.
    if (IMAGE_EXTENSIONS.has(ext)) {
      return [
        'img',
        {
          ...HTMLAttributes,
          'data-wiki-embed': '',
          'data-target': target,
          'data-alias': alias ?? '',
          'data-anchor': anchor ?? '',
          src: resolvedSrc ?? target,
          alt: alias ?? target,
        },
      ];
    }

    // Non-image or opaque → clickable link. A future phase will promote the
    // non-image typed extensions (pdf/mp4/mp3/…) to dedicated NodeViews
    // (Video/Audio/PDFViewer) at render time — storage shape unchanged.
    //
    // `target="_blank"` + `rel="noopener noreferrer"` is the drop-time
    // click surface. In web the
    // new-tab is the correct default. In Electron, `setWindowOpenHandler`
    // on the editor webContents (wired in `window-manager.ts`) intercepts
    // the new-window request, detects localhost asset URLs, and routes
    // to `openAssetSafely` — which dispatches to `shell.openPath` so the
    // OS default app opens the asset without replacing the editor
    // window. Without `target="_blank"` an Electron bare click would
    // replace the main webContents with the PDF viewer / binary
    // fallback and the user would lose the editor (the root-cause bug).
    //
    // Post-roundtrip the wiki-embed becomes a PM `text` + `link` mark
    // with `sourceForm='wikiembed'`, routed through `internal-link.ts`
    // handlePrimary + the renderer dispatcher. This `<a>` exists only
    // transiently between drop and the next save.
    const hrefBase = resolvedSrc ?? target;
    return [
      'a',
      {
        ...HTMLAttributes,
        'data-wiki-embed': '',
        'data-target': target,
        'data-alias': alias ?? '',
        'data-anchor': anchor ?? '',
        href: anchor ? `${hrefBase}#${anchor}` : hrefBase,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      labelFor({ target, alias, anchor }),
    ];
  },
});
