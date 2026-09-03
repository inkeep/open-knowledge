
import { sharedExtensions as coreExtensions, MarkdownManager } from '@inkeep/open-knowledge-core';
import { type ObserverDispatchKind, setupServerObservers } from '@inkeep/open-knowledge-server';
import { cleanup } from '@testing-library/react';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { sharedExtensions } from './shared';

const coreMd = new MarkdownManager({ extensions: coreExtensions });
const coreSchema = getSchema(coreExtensions);

const CALLOUT_SOURCE_RAW = '<Callout title="A">\n\nA body\n\n</Callout>';

function pristineCalloutJSON(bodyText: string): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'jsxComponent',
        attrs: {
          content: '',
          componentName: 'Callout',
          kind: 'element',
          attributes: [],
          sourceRaw: CALLOUT_SOURCE_RAW,
          sourceDirty: false,
          props: { title: 'A' },
        },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: bodyText }] }],
      },
    ],
  };
}

function observedDoc() {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  const dispatches: ObserverDispatchKind[] = [];
  const cleanupObservers = setupServerObservers({
    doc,
    xmlFragment,
    ytext,
    mdManager: coreMd,
    schema: coreSchema,
    onDispatch: (kind) => dispatches.push(kind),
  });
  return {
    doc,
    xmlFragment,
    ytext,
    observerADrains: () => dispatches.filter((k) => k === 'a').length,
    resetTally: () => {
      dispatches.length = 0;
    },
    cleanupObservers,
  };
}

function seedFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, json: JSONContent): void {
  const node = coreSchema.nodeFromJSON(json);
  doc.transact(() => {
    updateYFragment(doc, xmlFragment, node, { mapping: new Map(), isOMark: new Map() });
  });
}

function calloutInterior(editor: Editor): { interiorTextPos: number; sourceDirty: boolean } {
  let calloutPos = -1;
  let interiorTextPos = -1;
  let sourceDirty = false;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'jsxComponent' && calloutPos === -1) {
      calloutPos = pos;
      sourceDirty = Boolean(node.attrs.sourceDirty);
      return true;
    }
    if (calloutPos !== -1 && node.isText && interiorTextPos === -1) {
      interiorTextPos = pos + 1;
      return false;
    }
    return true;
  });
  if (interiorTextPos === -1) throw new Error('Callout interior text not found');
  return { interiorTextPos, sourceDirty };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('interior edit + sourceDirty flip fold into ONE Observer-A drain', () => {
  afterEach(() => {
    cleanup();
  });

  test('one interior edit through the real ySyncPlugin path settles as exactly ONE Observer-A serialize', async () => {
    const { doc, xmlFragment, ytext, observerADrains, resetTally, cleanupObservers } =
      observedDoc();
    seedFragment(doc, xmlFragment, pristineCalloutJSON('A body'));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new Editor({
      element: container,
      extensions: [...sharedExtensions, Collaboration.configure({ document: doc })],
      editable: true,
    });

    try {
      await tick();
      resetTally();

      const before = calloutInterior(editor);
      expect(before.sourceDirty).toBe(false);

      editor.commands.insertContentAt(before.interiorTextPos, 'ZZZ');
      await tick();

      const after = calloutInterior(editor);
      expect(after.sourceDirty).toBe(true);
      expect(observerADrains()).toBe(1);
      expect(ytext.toString()).toContain('ZZZ');
    } finally {
      editor.destroy();
      container.remove();
      cleanupObservers();
      doc.destroy();
    }
  });

  test('CONTROL: the same content edit + flip as two transactions fire TWO Observer-A drains', () => {
    const { doc, xmlFragment, ytext, observerADrains, resetTally, cleanupObservers } =
      observedDoc();
    seedFragment(doc, xmlFragment, pristineCalloutJSON('A body'));
    resetTally();

    const editedNode = coreSchema.nodeFromJSON(pristineCalloutJSON('A bodyZZZ'));
    doc.transact(() => {
      updateYFragment(doc, xmlFragment, editedNode, { mapping: new Map(), isOMark: new Map() });
    });
    expect(ytext.toString()).not.toContain('ZZZ');

    doc.transact(() => {
      (xmlFragment.get(0) as Y.XmlElement).setAttribute('sourceDirty', 'true');
    });

    expect(observerADrains()).toBe(2);
    expect(ytext.toString()).toContain('ZZZ');

    cleanupObservers();
    doc.destroy();
  });
});
