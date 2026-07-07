/**
 * Tag-click plugin — intercepts clicks on `<a class="tag" data-tag="…">`
 * inside the WYSIWYG editor and dispatches a single high-level event
 * (`ok:tag-click`) that the host app can react to (TagDialog mounts as a
 * listener; future surfaces like a Graph view can subscribe alongside).
 *
 * Why a `data-tag`-only selector:
 *   - Defines the contract independent of the visible class so clipboard
 *     paste / future renames of the `tag` styling class never silently
 *     break click handling.
 *   - Mirrors the wiki-link's chip pattern (`data-link`, `data-mark-id`)
 *     where data-attrs are the load-bearing stable hook and CSS classes
 *     are visual chrome.
 *
 * Cmd/Ctrl+click does the same thing as a bare click for now — both open
 * the dialog. The wiki-link convention reserves Cmd/Ctrl+click for "open
 * in a new tab" navigation; tags don't have a target route to navigate to
 * yet (a tag-search page is future work), so funneling both into the
 * dialog is the safe choice. When that page lands, the modifier branch
 * here can route to `window.open(buildTagSearchHref(value))` while bare
 * click keeps the dialog.
 *
 * `event.preventDefault()` is mandatory: the rendered anchor carries
 * `href="#tag/{value}"` (purely for keyboard / right-click affordances),
 * which would otherwise mutate `window.location.hash` and trigger SPA
 * route handlers.
 */

import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const TAG_CLICK_EVENT = 'ok:tag-click';

export interface TagClickEventDetail {
  /** Bare tag value, no `#` prefix. Hierarchy slashes preserved. */
  value: string;
}

/**
 * Imperatively dispatch a tag-click event with the given value. Used by
 * non-PM surfaces that need to feed into the same dialog (`TagDialog`)
 * pipeline — currently the property-panel `tags` list, where each chip
 * is a `<button>` (not a PM-managed `<a class="tag">`) and so doesn't
 * flow through the PM plugin's click handler. Keeping a single helper
 * means the dispatch contract (`{value}`) lives in one place; consumers
 * never need to construct the CustomEvent themselves.
 */
export function dispatchTagClickEvent(value: string): void {
  if (typeof document === 'undefined') return; // SSR / unit-test fallback
  const detail: TagClickEventDetail = { value };
  document.dispatchEvent(new CustomEvent<TagClickEventDetail>(TAG_CLICK_EVENT, { detail }));
}

function findTagAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  // Use closest so clicks on the inner text node (or a future child glyph)
  // still resolve to the anchor that carries `data-tag`.
  return target.closest<HTMLElement>('a[data-tag]');
}

export const TagClickPlugin = Extension.create({
  name: 'tagClick',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click(_view, event) {
              const anchor = findTagAnchor(event.target);
              if (!anchor) return false;
              const value = anchor.getAttribute('data-tag');
              if (!value) return false;

              event.preventDefault();
              event.stopPropagation();
              dispatchTagClickEvent(value);
              return true;
            },
          },
        },
      }),
    ];
  },
});
