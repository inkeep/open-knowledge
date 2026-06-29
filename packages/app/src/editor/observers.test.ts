import { describe, expect, test } from 'bun:test';
import { setTimeout } from 'node:timers/promises';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared';
import {
  getLastUserKeystroke,
  markUserTyping,
  ORIGIN_TEXT_TO_TREE,
  ORIGIN_TREE_TO_TEXT,
  setupObservers,
} from './observers';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

/** Helper: wait for debounce + microtask to settle. Must exceed TYPING_DEFER_MS (300ms)
 *  for tests that trigger the defer path (e.g., Y.Text writes from non-local origin). */
function wait(ms = 400): Promise<void> {
  return setTimeout(ms);
}

function applyMarkdown(doc: Y.Doc, fragment: Y.XmlFragment, md: string) {
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, fragment, pmNode, meta);
}

describe('Observer A: XmlFragment → Y.Text', () => {
  test('initial sync does NOT populate Y.Text (server-authoritative)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    applyMarkdown(doc, fragment, 'Hello world\n');

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    expect(ytext.toString()).toBe('');
    cleanup();
  });

  test('XmlFragment mutation does NOT propagate to Y.Text (server-authoritative)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    applyMarkdown(doc, fragment, 'New paragraph\n');

    await wait();

    expect(ytext.toString()).toBe('');
    cleanup();
  });

  test('skips changes with origin sync-from-text (prevents loop from Observer B)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    doc.transact(() => {
      ytext.insert(0, 'From text\n');
    }, 'external');

    await wait();

    const textAfter = ytext.toString();

    await wait();

    expect(ytext.toString()).toBe(textAfter);
    cleanup();
  });
});

describe('Observer B: Y.Text → XmlFragment', () => {
  test.skip('Y.Text mutation propagates to XmlFragment after debounce', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    doc.transact(() => {
      ytext.insert(0, '# Heading\n\nParagraph text\n');
    }, 'user-edit');

    await wait();

    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const md = mdManager.serialize(json);
    expect(md).toContain('# Heading');
    expect(md).toContain('Paragraph text');
    cleanup();
  });

  test('handles markdown parse errors gracefully — logs but does not crash', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    applyMarkdown(doc, fragment, 'Original content\n');
    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    await wait();

    doc.transact(() => {
      ytext.insert(0, '<Foo>broken text</Bar>\n');
    }, 'user-edit');

    await wait();

    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const md = mdManager.serialize(json);
    expect(md).toContain('Original content');

    cleanup();
  });

  test.skip('Observer B renders broken MDX as rawMdxFallback (G9 always-live) and recovers on next valid write', async () => {});
});

describe('WikiLink bridge regression', () => {
  test.skip('wikilink markdown survives XmlFragment ↔ Y.Text synchronization', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    try {
      applyMarkdown(doc, fragment, 'Alpha [[Page#Heading|Alias]]\n');

      await wait();

      expect(ytext.toString().trim()).toBe('Alpha [[Page#Heading|Alias]]');

      const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
      const md = mdManager.serialize(json);
      expect(md.trim()).toBe('Alpha [[Page#Heading|Alias]]');
    } finally {
      cleanup();
    }
  });
});

describe('Origin guard loop prevention', () => {
  test('single edit produces zero cross-CRDT writes (server-authoritative)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    let observerAFirings = 0;
    let observerBFirings = 0;

    fragment.observeDeep((_events, transaction) => {
      if (transaction.origin !== ORIGIN_TEXT_TO_TREE) return;
      observerBFirings++;
    });
    ytext.observe((_event, transaction) => {
      if (transaction.origin !== ORIGIN_TREE_TO_TEXT) return;
      observerAFirings++;
    });

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    applyMarkdown(doc, fragment, 'Test paragraph\n');

    await wait(200);

    expect(observerAFirings).toBe(0);
    expect(observerBFirings).toBe(0);

    cleanup();
  });
});

describe('Frontmatter handling', () => {
  test.skip('Observer A includes frontmatter from metadata map in Y.Text', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const metaMap = doc.getMap('metadata');
    metaMap.set('frontmatter', '---\ntitle: Test\n---\n');

    applyMarkdown(doc, fragment, '# Hello\n');
    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    expect(ytext.toString()).toContain('---\ntitle: Test\n---\n');
    expect(ytext.toString()).toContain('# Hello');
    cleanup();
  });

  test.skip('Observer B strips frontmatter and stores in metadata map', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    doc.transact(() => {
      ytext.insert(0, '---\ntitle: New\n---\n# Body\n');
    }, 'user-edit');

    await wait();

    const metaMap = doc.getMap('metadata');
    expect(metaMap.get('frontmatter')).toBe('---\ntitle: New\n---\n');

    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const md = mdManager.serialize(json);
    expect(md).toContain('# Body');
    cleanup();
  });
});

describe('Agent writes through observer chain', () => {
  test.skip('raw agent write to XmlFragment → Observer A → Y.Text updated', async () => {});

  test.skip('agent markdown write to Y.Text → Observer B → XmlFragment updated', async () => {});

  test.skip('agent markdown prepend to Y.Text → Observer B → XmlFragment updated with correct order', async () => {});

  test.skip('multiple rapid agent writes via XmlFragment all propagate to Y.Text', async () => {});

  test.skip('agent writes propagate bidirectionally: XmlFragment write visible in both', async () => {});
});

describe('Agent write origin and activity map', () => {
  test.skip('agent-write origin Y.Text write propagates to XmlFragment via Observer B', async () => {});

  test('activity map entries coexist with content writes in same transaction', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const activityMap = doc.getMap('agent-flash');

    let transactionCount = 0;
    doc.on('afterTransaction', () => {
      transactionCount++;
    });

    const beforeCount = transactionCount;

    doc.transact(() => {
      ytext.insert(0, 'Agent wrote this\n');
      activityMap.set('agent-1', {
        agentId: 'agent-1',
        timestamp: Date.now(),
        type: 'insert',
      });
    }, 'agent-write');

    expect(transactionCount - beforeCount).toBe(1);

    expect(ytext.toString()).toContain('Agent wrote this');
    expect(activityMap.get('agent-1')).toBeTruthy();
  });
});

describe('Per-origin undo (server-side UndoManager)', () => {
  test('UndoManager with trackedOrigins only captures agent-write transactions', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent-write']),
      captureTimeout: 0,
    });

    doc.transact(() => {
      ytext.insert(0, 'Human wrote this\n');
    }, 'user-edit');

    doc.transact(() => {
      ytext.insert(ytext.length, 'Agent wrote this\n');
    }, 'agent-write');

    expect(ytext.toString()).toBe('Human wrote this\nAgent wrote this\n');
    expect(undoManager.canUndo()).toBe(true);

    undoManager.undo();

    expect(ytext.toString()).toBe('Human wrote this\n');
    expect(undoManager.canUndo()).toBe(false);
    expect(undoManager.canRedo()).toBe(true);
  });

  test('interleaved human+agent edits — undo reverses only agent changes in order', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent-write']),
      captureTimeout: 0,
    });

    doc.transact(() => {
      ytext.insert(0, 'Human 1\n');
    }, 'user-edit');

    doc.transact(() => {
      ytext.insert(ytext.length, 'Agent 1\n');
    }, 'agent-write');

    doc.transact(() => {
      ytext.insert(ytext.length, 'Human 2\n');
    }, 'user-edit');

    doc.transact(() => {
      ytext.insert(ytext.length, 'Agent 2\n');
    }, 'agent-write');

    expect(ytext.toString()).toBe('Human 1\nAgent 1\nHuman 2\nAgent 2\n');

    undoManager.undo();
    expect(ytext.toString()).toBe('Human 1\nAgent 1\nHuman 2\n');

    undoManager.undo();
    expect(ytext.toString()).toBe('Human 1\nHuman 2\n');

    expect(undoManager.canUndo()).toBe(false);

    expect(ytext.toString()).toContain('Human 1');
    expect(ytext.toString()).toContain('Human 2');
  });

  test('redo restores agent edits', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent-write']),
      captureTimeout: 0,
    });

    doc.transact(() => {
      ytext.insert(0, 'Agent content\n');
    }, 'agent-write');

    undoManager.undo();
    expect(ytext.toString()).toBe('');
    expect(undoManager.canRedo()).toBe(true);

    undoManager.redo();
    expect(ytext.toString()).toBe('Agent content\n');
  });

  test.skip('agent undo propagates through Observer B to XmlFragment', async () => {});

  test('multiple UndoManagers on same Y.Text do not conflict', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const browserUM = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['browser-edit']),
    });

    const agentUM = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent-write']),
    });

    doc.transact(() => {
      ytext.insert(0, 'Browser typed this\n');
    }, 'browser-edit');

    doc.transact(() => {
      ytext.insert(ytext.length, 'Agent wrote this\n');
    }, 'agent-write');

    expect(ytext.toString()).toBe('Browser typed this\nAgent wrote this\n');

    agentUM.undo();
    expect(ytext.toString()).toBe('Browser typed this\n');

    browserUM.undo();
    expect(ytext.toString()).toBe('');

    browserUM.redo();
    expect(ytext.toString()).toBe('Browser typed this\n');

    agentUM.redo();
    expect(ytext.toString()).toBe('Browser typed this\nAgent wrote this\n');
  });
});

describe('Y.Text CRDT foundation', () => {
  test('Y.Text content is accessible after write — simulates collaborative source mode', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    doc.transact(() => {
      ytext.insert(0, '# Hello from source\n\nCollaborative editing works.\n');
    });

    expect(ytext.toString()).toBe('# Hello from source\n\nCollaborative editing works.\n');
    expect(ytext.length).toBeGreaterThan(0);
  });

  test('two Y.Docs sync Y.Text via state exchange — simulates multi-tab', () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const ytext1 = doc1.getText('source');
    doc1.transact(() => {
      ytext1.insert(0, 'Tab 1 typed this');
    });

    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const ytext2 = doc2.getText('source');
    expect(ytext2.toString()).toBe('Tab 1 typed this');
  });
});

describe('Concurrent edit race conditions (regression)', () => {
  test.skip('Observer B defers while user is typing to avoid destroying in-flight edits', async () => {});

  test.skip('Observer B early-exits when XmlFragment already matches Y.Text', async () => {});

  test.skip('Observer A defers after agent write so the diff does not subtract agent content', async () => {});

  test.skip('agent undo during active user typing — user keystrokes preserved, agent text removed', async () => {});
});

describe('Remote write baseline staleness (regression)', () => {
  test.skip('remote agent write with non-stable markdown does not duplicate on local type', async () => {});

  test.skip('typing state is isolated per Y.Doc', async () => {});
});

describe('R7: source-mode typing defers Observer B', () => {
  test.skip('markUserTyping(doc) from source-mode events defers tree replacement', async () => {});
});

describe('Observer A: remote transaction baseline refresh', () => {
  test.skip('remote write propagates, then next local edit computes delta from refreshed baseline', async () => {});
  test.skip('multiple sequential remote writes each refresh baseline', async () => {});
  test.skip('remote delete refreshes baseline so next local add does not resurrect deleted content', async () => {});
});

describe('applyUserDelta: divergence preservation', () => {
  test.skip('user adds a paragraph — agent content already in Y.Text is preserved', async () => {});
  test.skip('user deletes a baseline paragraph — agent content is preserved, deletion applied', async () => {});
  test.skip('user modifies a baseline line — agent content is preserved, modification applied', async () => {});
});

describe('FR-1: content-comparison gate skips no-op replacements', () => {
  test('Observer A produces zero ORIGIN_TREE_TO_TEXT mutations (server-authoritative)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const md = '# Hello\n\nWorld.\n';
    applyMarkdown(doc, fragment, md);
    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });
    await wait();

    let deleteCount = 0;
    let insertCount = 0;
    ytext.observe((event) => {
      if (event.transaction.origin !== ORIGIN_TREE_TO_TEXT) return;
      for (const delta of event.delta) {
        if ('delete' in delta) deleteCount++;
        if ('insert' in delta) insertCount++;
      }
    });

    applyMarkdown(doc, fragment, md);
    await wait();

    expect(deleteCount).toBe(0);
    expect(insertCount).toBe(0);

    cleanup();
  });

  test.skip('Path A multi-hunk diff with length-changing first hunk produces correct ytext', async () => {});
});

describe('FR-2: applyUserDelta DMP three-way merge', () => {
  test.skip('B1: same-line collision merges both edits', async () => {});
  test.skip('B2: prepend + append preserves both', async () => {});
  test.skip('B3: different-line edits preserve both', async () => {});
  test.skip('B4: user-delete + agent-modify same line — user-wins (D9)', async () => {});
  test.skip('B5: exact-char overlap — D8 duplication characterization', async () => {});
  test.skip('early return produces zero CRDT mutations when merged text equals agent text', async () => {});
});

describe('FR-7: onMergeFailed diagnostic', () => {
  test.skip('no diagnostic on successful three-way merge', async () => {});
  test.skip('diagnostic fires on failed patches (unmatchable agent text)', async () => {});
});

describe('FR-4: Observer A preserves agent-origin CRDT Items', () => {
  test.skip('Path A: content-gate preserves agent Items (UM stack survives sync)', async () => {});
  test.skip('Path B: DMP merge preserves agent Items in non-overlapping regions', async () => {});
});

describe('A1: middle-region replacement preserves outer agent Items', () => {
  test('middle-region replacement preserves outer agent Items', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const um = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent-write']),
      captureTimeout: 0,
    });

    doc.transact(() => {
      ytext.insert(0, 'AAA');
    }, 'agent-write');
    doc.transact(() => {
      ytext.insert(3, 'BBB');
    }, ORIGIN_TREE_TO_TEXT);
    doc.transact(() => {
      ytext.insert(6, 'CCC');
    }, 'agent-write');

    expect(ytext.toString()).toBe('AAABBBCCC');
    expect(um.undoStack.length).toBe(2);

    doc.transact(() => {
      ytext.delete(3, 3); // remove 'BBB'
      ytext.insert(3, 'XXX'); // insert 'XXX'
    }, ORIGIN_TREE_TO_TEXT);

    expect(ytext.toString()).toBe('AAAXXXCCC');

    expect(um.undoStack.length).toBe(2);

    um.undo(); // reverts CCC
    expect(ytext.toString()).toBe('AAAXXX');
    um.undo(); // reverts AAA
    expect(ytext.toString()).toBe('XXX');

    um.destroy();
  });
});

describe('markUserTyping — global keystroke timestamp (US-006)', () => {
  test('getLastUserKeystroke advances on markUserTyping', () => {
    const before = getLastUserKeystroke();
    markUserTyping();
    const after = getLastUserKeystroke();
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });

  test('global timestamp is shared across call sites (no per-doc state)', () => {
    markUserTyping();
    const ts1 = getLastUserKeystroke();
    const wait = Date.now() + 1;
    while (Date.now() < wait) {}
    markUserTyping();
    const ts2 = getLastUserKeystroke();
    expect(ts2).toBeGreaterThan(ts1);
  });
});
