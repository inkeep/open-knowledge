/**
 * FootnoteAnchorScroll — app-only click handler that intercepts clicks on
 * footnote anchors inside the editor and scrolls to the matching target
 * without mutating `window.location.hash`. Handles both navigation
 * directions:
 *
 *   - Reference → definition: `<sup><a href="#fn-{id}">[id]</a></sup>`
 *     scrolls to `<aside id="fn-{id}">` at the foot of the document.
 *   - Definition → reference: `<a class="footnote-backref" href="#fnref-{id}">↩</a>`
 *     scrolls back to `<sup id="fnref-{id}">` at the original reference site.
 *
 * The static `renderHTML` shapes are deliberately kept anchor-shaped so
 * cross-app paste destinations (Gmail, Slack, the docs site) get working
 * in-document links without extra JS. Inside the OK editor, however,
 * `location.hash = "#fn-1"` (or `"#fnref-1"`) collides with the SPA's
 * `#/<docName>` routing — `docNameFromHash("#fn-1")` returns null and
 * the app treats the navigation as "clear", breaking the showcase /
 * regular-doc view. We intercept the click before the browser sets the
 * hash and `scrollIntoView` the target instead.
 *
 * Kept out of `core/extensions/footnote-reference.ts` for the same reason
 * `HeadingAnchors` is app-only: the server doesn't render interactive HTML,
 * the behavior doesn't mutate the document or serialized markdown, and
 * cross-app static destinations should still get default browser behavior.
 */
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

// Matches forward (`#fn-1`) AND back (`#fnref-1`) footnote anchors. Used to
// distinguish footnote hrefs from arbitrary `#`-anchors inside the editor.
const FOOTNOTE_HREF_RE = /^#fn(?:ref)?-/;

export const FootnoteAnchorScroll = Extension.create({
  name: 'footnoteAnchorScroll',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click(view, event) {
              const target = event.target;
              if (!(target instanceof Element)) return false;
              // Match either the forward link (`#fn-{id}`) on the reference
              // or the back-link (`#fnref-{id}`) on the definition.
              const anchor = target.closest('a[href^="#fn"]');
              if (!(anchor instanceof HTMLAnchorElement)) return false;
              const href = anchor.getAttribute('href') ?? '';
              if (!FOOTNOTE_HREF_RE.test(href)) return false;
              // `href` is `#fn-{id}` or `#fnref-{id}`; the matching target
              // element renders with `id="fn-{id}"` (definition aside) or
              // `id="fnref-{id}"` (reference sup) respectively.
              const targetId = href.slice(1);
              // preventDefault even if the target isn't found — letting the
              // browser navigate would clobber the SPA's `#/<docName>`
              // route. Without a target we silently no-op (matches "broken
              // anchor" behavior in static HTML — clicking a `#fn-missing`
              // also does nothing visible there).
              event.preventDefault();
              const matchEl = view.dom.ownerDocument.getElementById(targetId);
              if (matchEl) {
                matchEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
              return true;
            },
          },
        },
      }),
    ];
  },
});
