import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

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
              const anchor = target.closest('a[href^="#fn"]');
              if (!(anchor instanceof HTMLAnchorElement)) return false;
              const href = anchor.getAttribute('href') ?? '';
              if (!FOOTNOTE_HREF_RE.test(href)) return false;
              const targetId = href.slice(1);
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
