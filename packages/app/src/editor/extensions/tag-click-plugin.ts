
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const TAG_CLICK_EVENT = 'ok:tag-click';

export interface TagClickEventDetail {
  value: string;
}

export function dispatchTagClickEvent(value: string): void {
  if (typeof document === 'undefined') return; // SSR / unit-test fallback
  const detail: TagClickEventDetail = { value };
  document.dispatchEvent(new CustomEvent<TagClickEventDetail>(TAG_CLICK_EVENT, { detail }));
}

function findTagAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
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
