
import { classifyMarkdownHref, resolveAssetProjectPath } from '@inkeep/open-knowledge-core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

type ContextMenuTargetKind = 'asset' | 'wiki-link' | 'image';

interface ContextMenuTarget {
  readonly kind: ContextMenuTargetKind;
  readonly relPath: string;
  readonly title: string;
}

export function classifyContextMenuTarget(
  element: Element,
  sourceDocName: string,
): ContextMenuTarget | null {
  let cur: Element | null = element;
  while (cur && typeof cur.hasAttribute === 'function') {
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
    if (cur.hasAttribute('data-wiki-link')) {
      const target = cur.getAttribute('data-target') ?? '';
      if (!target) return null;
      return {
        kind: 'wiki-link',
        relPath: `${target}.md`,
        title: target,
      };
    }
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
    }
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
  readonly sourceDocName: string;
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
