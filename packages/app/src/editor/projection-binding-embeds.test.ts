import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor } from '@tiptap/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  __resetEmbedAssetsForTests,
  resolveEmbedAsset,
  setEmbedAssetPaths,
  subscribeEmbedAssets,
} from './embed-asset-index';
import { createProjectionBinding, type ProjectionBinding } from './projection-binding';
import { installDomGlobals } from './walk-currency-test-harness';

const projectionMd = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

let restoreDom: (() => void) | undefined;
beforeAll(() => {
  restoreDom = installDomGlobals();
});
afterAll(() => {
  restoreDom?.();
});
afterEach(() => {
  __resetEmbedAssetsForTests();
});

interface EmbedRig {
  editor: Editor;
  ytext: Y.Text;
  binding: ProjectionBinding;
  destroy(): void;
}

function createEmbedRig(source: string): EmbedRig {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ydoc.transact(() => ytext.insert(0, source), 'seed');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const binding = createProjectionBinding({
    ytext,
    md: projectionMd.withParseContext({
      resolveEmbed: resolveEmbedAsset,
      sourcePath: 'notes/meeting',
    }),
    subscribeEmbedAssets,
  });
  const editor = new Editor({
    element: host,
    content: binding.content,
    extensions: [...sharedExtensions, binding.extension],
  });
  return {
    editor,
    ytext,
    binding,
    destroy() {
      editor.destroy();
      host.remove();
      ydoc.destroy();
    },
  };
}

function embedSrcs(editor: Editor): string[] {
  const srcs: string[] = [];
  editor.state.doc.descendants((node) => {
    const componentName = node.attrs.componentName;
    if (typeof componentName === 'string' && componentName.startsWith('WikiEmbed')) {
      srcs.push(String(node.attrs.props?.src));
    }
    return true;
  });
  return srcs;
}

function textPos(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text);
    }
    return found === -1;
  });
  return found;
}

describe('projection binding — embeds follow the asset index', () => {
  it('projects a bare embed onto the asset the index names', () => {
    setEmbedAssetPaths(['assets/pic.png']);
    const rig = createEmbedRig('# Title\n\n![[pic.png]]\n');
    expect(embedSrcs(rig.editor)).toEqual(['/assets/pic.png']);
    rig.destroy();
  });

  it('re-projects when the asset appears, without a write or an undo step', () => {
    const rig = createEmbedRig('# Title\n\n![[pic.png]]\n');
    expect(embedSrcs(rig.editor)).toEqual(['pic.png']);
    const before = rig.ytext.toString();

    setEmbedAssetPaths(['assets/pic.png']);

    expect(embedSrcs(rig.editor)).toEqual(['/assets/pic.png']);
    expect(rig.ytext.toString()).toBe(before);
    expect(rig.binding.stats.writes).toBe(0);
    expect(rig.binding.undoManager.undoStack.length).toBe(0);
    rig.destroy();
  });

  it('follows the asset when it moves', () => {
    setEmbedAssetPaths(['pic.png']);
    const rig = createEmbedRig('# Title\n\n![[pic.png]]\n');
    expect(embedSrcs(rig.editor)).toEqual(['/pic.png']);

    setEmbedAssetPaths(['assets/pic.png']);

    expect(embedSrcs(rig.editor)).toEqual(['/assets/pic.png']);
    rig.destroy();
  });

  it('leaves a document without embeds alone when the index changes', () => {
    const rig = createEmbedRig('# Title\n\nPlain text.\n');
    const doc = rig.editor.state.doc;
    const rebuilds = rig.binding.stats.rebuilds;

    setEmbedAssetPaths(['assets/pic.png']);

    expect(rig.editor.state.doc).toBe(doc);
    expect(rig.binding.stats.rebuilds).toBe(rebuilds);
    rig.destroy();
  });

  it('keeps the caret where it was across the re-projection', () => {
    const rig = createEmbedRig('# Title\n\n![[pic.png]]\n\nTail text.\n');
    const at = textPos(rig.editor, 'text');
    rig.editor.commands.setTextSelection(at);

    setEmbedAssetPaths(['assets/pic.png']);

    expect(embedSrcs(rig.editor)).toEqual(['/assets/pic.png']);
    expect(rig.editor.state.selection.from).toBe(at);
    expect(rig.editor.state.selection.empty).toBe(true);
    rig.destroy();
  });

  it('stops following the index once the editor is destroyed', () => {
    const rig = createEmbedRig('# Title\n\n![[pic.png]]\n');
    rig.destroy();
    expect(() => setEmbedAssetPaths(['assets/pic.png'])).not.toThrow();
  });
});
