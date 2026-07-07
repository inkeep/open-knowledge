/**
 * End-to-end test: Agent writes via DirectConnection → changes reflected in editor serialization.
 *
 * This validates the critical user flow:
 * 1. Agent writes a paragraph via DirectConnection (V3)
 * 2. The Y.Doc is updated with the new content
 * 3. Serializing the Y.Doc to markdown (WYSIWYG → source path) includes the agent's content
 * 4. Re-parsing that markdown back to Y.Doc (source → WYSIWYG path) preserves the agent's content
 *
 * This is a server-side test that exercises the same code paths as the browser editor,
 * without requiring a browser. The CRDT layer (Yjs) and the unified + remark
 * serialization layer (MarkdownManager) are the same in both environments.
 */
import { describe, expect, test } from 'bun:test';
import { Hocuspocus } from '@hocuspocus/server';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { sharedExtensions } from '../editor/extensions/shared';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

type Conn = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

/** Get the Y.Doc from a DirectConnection, throwing if unavailable */
function getDoc(conn: Conn) {
  const doc = conn.document;
  if (!doc) throw new Error('DirectConnection has no document');
  return doc;
}

/** Get the default XmlFragment from a DirectConnection */
function getFragment(conn: Conn) {
  return getDoc(conn).getXmlFragment('default');
}

describe('Agent write → Editor reflection', () => {
  test('agent write via DirectConnection appears in Y.Doc and serializes to markdown', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });

    // Simulate: agent opens a DirectConnection and writes a paragraph
    const conn = await hocuspocus.openDirectConnection('test-agent-flow');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.applyDelta([{ insert: 'Hello from the agent!' }]);
      paragraph.insert(0, [text]);
      fragment.push([paragraph]);
    });

    // Now serialize Y.Doc → markdown (this is what getMarkdown() does in TiptapEditor)
    const fragment = getFragment(conn);
    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const markdown = mdManager.serialize(json);

    expect(markdown).toContain('Hello from the agent!');

    await conn.disconnect();
    // Hocuspocus cleanup handled by GC
  });

  test('agent write survives full source toggle round-trip (WYSIWYG → source → WYSIWYG)', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });

    // Step 1: Seed document with initial content
    const conn = await hocuspocus.openDirectConnection('test-toggle-flow');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');

      // Existing user content
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'User wrote this paragraph' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

    // Step 2: Agent writes another paragraph (simulates agent writing while doc is open)
    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');

      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.applyDelta([{ insert: 'Agent added this paragraph' }]);
      p2.insert(0, [t2]);
      fragment.push([p2]);
    });

    // Step 3: Toggle to source — serialize Y.Doc → markdown
    const fragment = getFragment(conn);
    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const sourceMarkdown = mdManager.serialize(json);

    // Both user and agent content should be in the markdown
    expect(sourceMarkdown).toContain('User wrote this paragraph');
    expect(sourceMarkdown).toContain('Agent added this paragraph');

    // Step 4: Simulate user editing in source mode — add a line
    const editedMarkdown = `${sourceMarkdown}\nUser edited this in source mode\n`;

    // Step 5: Toggle back to WYSIWYG — parse markdown → updateYFragment
    const parsedJson = mdManager.parse(editedMarkdown);
    const pmNode = schema.nodeFromJSON(parsedJson);

    getDoc(conn).transact(() => {
      updateYFragment(getDoc(conn), fragment, pmNode, {
        mapping: new Map(),
        isOMark: new Map(),
      });
    });

    // Step 6: Verify — serialize again to check all content survived
    const finalJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const finalMarkdown = mdManager.serialize(finalJson);

    expect(finalMarkdown).toContain('User wrote this paragraph');
    expect(finalMarkdown).toContain('Agent added this paragraph');
    expect(finalMarkdown).toContain('User edited this in source mode');

    await conn.disconnect();
    // Hocuspocus cleanup handled by GC
  });

  test('multiple agent writes while editor has existing content', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-multi-agent');

    // Seed with content
    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.applyDelta([{ insert: 'Existing content' }]);
      p.insert(0, [t]);
      fragment.push([p]);
    });

    // 5 rapid agent writes
    for (let i = 0; i < 5; i++) {
      await conn.transact((doc) => {
        const fragment = doc.getXmlFragment('default');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.applyDelta([{ insert: `Agent write #${i + 1}` }]);
        p.insert(0, [t]);
        fragment.push([p]);
      });
    }

    // Serialize and verify all writes are present
    const fragment = getFragment(conn);
    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const markdown = mdManager.serialize(json);

    expect(markdown).toContain('Existing content');
    for (let i = 0; i < 5; i++) {
      expect(markdown).toContain(`Agent write #${i + 1}`);
    }

    // Verify fragment has 6 children (1 existing + 5 agent writes)
    expect(fragment.length).toBe(6);

    await conn.disconnect();
    // Hocuspocus cleanup handled by GC
  });

  test('agent markdown write via direct Y.Text insertion appends content', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-md-write');

    // Seed with initial content
    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'Existing paragraph one' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

    // Simulate the new agent-write-md path: direct Y.Text insertion
    // This is what POST /api/agent-write-md now does
    const doc = getDoc(conn);
    const ytext = doc.getText('source');

    // First, populate Y.Text (simulates Observer A initial sync)
    const fragment = getFragment(conn);
    const currentJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const currentMarkdown = mdManager.serialize(currentJson);
    doc.transact(() => {
      ytext.insert(0, currentMarkdown);
    });

    // Agent appends markdown via Y.Text insertion
    const agentMarkdown = 'Agent wrote this via markdown path';
    const currentText = ytext.toString();
    const insertAt = currentText.length;
    const separator = currentText.trim() ? '\n\n' : '';
    doc.transact(() => {
      ytext.insert(insertAt, `${separator}${agentMarkdown.trim()}\n`);
    }, 'agent-write');

    // Verify Y.Text has both contents
    const finalText = ytext.toString();
    expect(finalText).toContain('Existing paragraph one');
    expect(finalText).toContain('Agent wrote this via markdown path');

    await conn.disconnect();
  });

  test('source mode injection: agent write updates serialized markdown while in source mode', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-source-inject');

    // Seed with initial content
    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'User content in source mode' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

    // Simulate entering source mode: take a snapshot
    const fragment = getFragment(conn);
    const snapshotJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const snapshotMarkdown = mdManager.serialize(snapshotJson);
    expect(snapshotMarkdown).toContain('User content in source mode');

    // Set up Y.Doc observer (simulates what App.tsx does in source mode)
    let latestMarkdown = snapshotMarkdown;
    const observer = () => {
      const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
      latestMarkdown = mdManager.serialize(json);
    };
    fragment.observeDeep(observer);

    // Agent writes via markdown path (same as POST /api/agent-write-md)
    const agentMd = 'Agent injected this during source mode';
    const combined = `${snapshotMarkdown.trim()}\n\n${agentMd}\n`;
    const parsedJson = mdManager.parse(combined);
    const pmNode = schema.nodeFromJSON(parsedJson);

    getDoc(conn).transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(getDoc(conn), fragment, pmNode, meta);
    });

    // The observer should have fired — latestMarkdown should include agent's write
    expect(latestMarkdown).toContain('User content in source mode');
    expect(latestMarkdown).toContain('Agent injected this during source mode');

    fragment.unobserveDeep(observer);
    await conn.disconnect();
  });

  test('agent markdown write (prepend position) inserts before existing content', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-md-prepend');

    // Seed with initial content
    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'Original first paragraph' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

    // Prepend agent markdown
    const fragment = getFragment(conn);
    const currentJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const currentMarkdown = mdManager.serialize(currentJson);

    const agentMarkdown = 'Agent prepended this';
    const combined = `${agentMarkdown}\n\n${currentMarkdown.trim()}\n`;

    const parsedJson = mdManager.parse(combined);
    const pmNode = schema.nodeFromJSON(parsedJson);

    getDoc(conn).transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(getDoc(conn), fragment, pmNode, meta);
    });

    // Verify order: agent's paragraph first, then original
    const finalJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const finalMarkdown = mdManager.serialize(finalJson);

    expect(finalMarkdown).toContain('Agent prepended this');
    expect(finalMarkdown).toContain('Original first paragraph');

    // Verify order
    const agentIdx = finalMarkdown.indexOf('Agent prepended this');
    const originalIdx = finalMarkdown.indexOf('Original first paragraph');
    expect(agentIdx).toBeLessThan(originalIdx);

    await conn.disconnect();
  });
});
