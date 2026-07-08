/**
 * Fold-atomicity anti-race pin (Observer-A altitude, real-engine rung).
 *
 * A prior evaluation hypothesized a drain race: the interior content mutation
 * and the sourceDirty flip could reach the bridge as two separate Y.Doc
 * transactions, letting Observer A serialize a half-updated fragment between
 * them — the first serialize firing while the component is still pristine
 * (sourceDirty:false) would emit the stale verbatim sourceRaw, dropping the
 * edit for every fresh parser until the second drain re-derived it.
 *
 * This pins why that race is unreachable. The source-dirty observer folds the
 * flip into the SAME ProseMirror dispatch as the content edit (an
 * appendTransaction, not a deferred one), so y-prosemirror's ySyncPlugin syncs
 * both in ONE Y.Doc transaction, which settles as exactly ONE Observer-A
 * serialize. The folded case drives a mounted editor bound through
 * Collaboration (the production ySyncPlugin path) so the full
 * dispatch -> ySyncPlugin -> Observer-A chain is exercised, not modelled.
 *
 * Observation is the precise Observer-A dispatch tally (`onDispatch('a')`), not
 * bare PM-state counting — the tally is blind to nothing but the drains that
 * are Observer-A serializes. The tally is validated against a deliberate
 * two-transaction control on a plain doc: the SAME content edit and flip,
 * applied as two Y.Doc transactions, fire two 'a' drains, proving the probe is
 * not vacuously counting one.
 *
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sharedExtensions as coreExtensions, MarkdownManager } from '@inkeep/open-knowledge-core';
import { type ObserverDispatchKind, setupServerObservers } from '@inkeep/open-knowledge-server';
import { cleanup } from '@testing-library/react';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { updateYFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { sharedExtensions } from './shared';

// Server-side bridge uses core's extensions (no React NodeViews) exactly like
// production and the integration harness — the fragment is generic XML, so a
// core-schema observer reads what an app-schema editor wrote.
const coreMd = new MarkdownManager({ extensions: coreExtensions });
const coreSchema = getSchema(coreExtensions);

const CALLOUT_SOURCE_RAW = '<Callout title="A">\n\nA body\n\n</Callout>';

/** Pristine (sourceDirty:false) Callout carrying authoritative sourceRaw + a
 *  paragraph child — the shape mdast->PM parse handlers emit. */
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

/** A doc + bridge observers + an Observer-A dispatch tally. The tally counts
 *  only 'a' drains (Observer A serializes the fragment into Y.Text); Observer
 *  A's own Y.Text write settles as a separate OBSERVER_SYNC_ORIGIN drain the
 *  dispatcher classifies 'none', so it never inflates the count. */
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

/** Seed a fragment from a PM doc JSON in ONE transaction (the paired-write seed
 *  altitude — observers attach afterward against a settled baseline). */
function seedFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, json: JSONContent): void {
  const node = coreSchema.nodeFromJSON(json);
  doc.transact(() => {
    updateYFragment(doc, xmlFragment, node, { mapping: new Map(), isOMark: new Map() });
  });
}

/** First jsxComponent's interior text position + its dirty flag, read off a
 *  live editor state (mirrors the interior-content flip pin). */
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
    // Seed the pristine Callout, then attach the editor via Collaboration so
    // ySyncPlugin owns the fragment (no `content` option — Collaboration is the
    // source of truth). The tally starts after mount so init/prewarm drains
    // don't contaminate it.
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
      expect(before.sourceDirty).toBe(false); // pristine — the fold must do the flip

      editor.commands.insertContentAt(before.interiorTextPos, 'ZZZ');
      // A deferred (separate-dispatch) flip would surface as a SECOND 'a' drain
      // after this tick; the fold keeps it to one.
      await tick();

      const after = calloutInterior(editor);
      expect(after.sourceDirty).toBe(true); // content + flip landed together
      expect(observerADrains()).toBe(1);
      expect(ytext.toString()).toContain('ZZZ'); // the one serialize emitted fresh bytes
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

    // Transaction 1 — the content edit alone (still sourceDirty:false). This is
    // the half-updated state the fold makes unreachable: Observer A serializes
    // the pristine-flagged component here, emitting the stale sourceRaw.
    const editedNode = coreSchema.nodeFromJSON(pristineCalloutJSON('A bodyZZZ'));
    doc.transact(() => {
      updateYFragment(doc, xmlFragment, editedNode, { mapping: new Map(), isOMark: new Map() });
    });
    expect(ytext.toString()).not.toContain('ZZZ'); // stale window: verbatim sourceRaw, no edit

    // Transaction 2 — the flip, in its own transaction.
    doc.transact(() => {
      (xmlFragment.get(0) as Y.XmlElement).setAttribute('sourceDirty', 'true');
    });

    expect(observerADrains()).toBe(2); // two transactions => two 'a' drains (probe discriminates)
    expect(ytext.toString()).toContain('ZZZ'); // second drain re-derived the fresh bytes

    cleanupObservers();
    doc.destroy();
  });
});
