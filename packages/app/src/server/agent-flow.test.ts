import { Hocuspocus } from '@hocuspocus/server';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { sharedExtensions } from '../editor/extensions/shared';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

type Conn = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

function getDoc(conn: Conn) {
  const doc = conn.document;
  if (!doc) throw new Error('DirectConnection has no document');
  return doc;
}

function getFragment(conn: Conn) {
  return getDoc(conn).getXmlFragment('default');
}

describe('Agent write → Editor reflection', () => {
  test('agent write via DirectConnection appears in Y.Doc and serializes to markdown', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });

    const conn = await hocuspocus.openDirectConnection('test-agent-flow');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.applyDelta([{ insert: 'Hello from the agent!' }]);
      paragraph.insert(0, [text]);
      fragment.push([paragraph]);
    });

    const fragment = getFragment(conn);
    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const markdown = mdManager.serialize(json);

    expect(markdown).toContain('Hello from the agent!');

    await conn.disconnect();
  });

  test('agent write survives full source toggle round-trip (WYSIWYG → source → WYSIWYG)', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });

    const conn = await hocuspocus.openDirectConnection('test-toggle-flow');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');

      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'User wrote this paragraph' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');

      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.applyDelta([{ insert: 'Agent added this paragraph' }]);
      p2.insert(0, [t2]);
      fragment.push([p2]);
    });

    const fragment = getFragment(conn);
    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const sourceMarkdown = mdManager.serialize(json);

    expect(sourceMarkdown).toContain('User wrote this paragraph');
    expect(sourceMarkdown).toContain('Agent added this paragraph');

    const editedMarkdown = `${sourceMarkdown}\nUser edited this in source mode\n`;

    const parsedJson = mdManager.parse(editedMarkdown);
    const pmNode = schema.nodeFromJSON(parsedJson);

    getDoc(conn).transact(() => {
      updateYFragment(getDoc(conn), fragment, pmNode, {
        mapping: new Map(),
        isOMark: new Map(),
      });
    });

    const finalJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const finalMarkdown = mdManager.serialize(finalJson);

    expect(finalMarkdown).toContain('User wrote this paragraph');
    expect(finalMarkdown).toContain('Agent added this paragraph');
    expect(finalMarkdown).toContain('User edited this in source mode');

    await conn.disconnect();
  });

  test('multiple agent writes while editor has existing content', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-multi-agent');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.applyDelta([{ insert: 'Existing content' }]);
      p.insert(0, [t]);
      fragment.push([p]);
    });

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

    const fragment = getFragment(conn);
    const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const markdown = mdManager.serialize(json);

    expect(markdown).toContain('Existing content');
    for (let i = 0; i < 5; i++) {
      expect(markdown).toContain(`Agent write #${i + 1}`);
    }

    expect(fragment.length).toBe(6);

    await conn.disconnect();
  });

  test('agent markdown write via direct Y.Text insertion appends content', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-md-write');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'Existing paragraph one' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

    const doc = getDoc(conn);
    const ytext = doc.getText('source');

    const fragment = getFragment(conn);
    const currentJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const currentMarkdown = mdManager.serialize(currentJson);
    doc.transact(() => {
      ytext.insert(0, currentMarkdown);
    });

    const agentMarkdown = 'Agent wrote this via markdown path';
    const currentText = ytext.toString();
    const insertAt = currentText.length;
    const separator = currentText.trim() ? '\n\n' : '';
    doc.transact(() => {
      ytext.insert(insertAt, `${separator}${agentMarkdown.trim()}\n`);
    }, 'agent-write');

    const finalText = ytext.toString();
    expect(finalText).toContain('Existing paragraph one');
    expect(finalText).toContain('Agent wrote this via markdown path');

    await conn.disconnect();
  });

  test('source mode injection: agent write updates serialized markdown while in source mode', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-source-inject');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'User content in source mode' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

    const fragment = getFragment(conn);
    const snapshotJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const snapshotMarkdown = mdManager.serialize(snapshotJson);
    expect(snapshotMarkdown).toContain('User content in source mode');

    let latestMarkdown = snapshotMarkdown;
    const observer = () => {
      const json = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
      latestMarkdown = mdManager.serialize(json);
    };
    fragment.observeDeep(observer);

    const agentMd = 'Agent injected this during source mode';
    const combined = `${snapshotMarkdown.trim()}\n\n${agentMd}\n`;
    const parsedJson = mdManager.parse(combined);
    const pmNode = schema.nodeFromJSON(parsedJson);

    getDoc(conn).transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(getDoc(conn), fragment, pmNode, meta);
    });

    expect(latestMarkdown).toContain('User content in source mode');
    expect(latestMarkdown).toContain('Agent injected this during source mode');

    fragment.unobserveDeep(observer);
    await conn.disconnect();
  });

  test('agent markdown write (prepend position) inserts before existing content', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('test-md-prepend');

    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.applyDelta([{ insert: 'Original first paragraph' }]);
      p1.insert(0, [t1]);
      fragment.push([p1]);
    });

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

    const finalJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
    const finalMarkdown = mdManager.serialize(finalJson);

    expect(finalMarkdown).toContain('Agent prepended this');
    expect(finalMarkdown).toContain('Original first paragraph');

    const agentIdx = finalMarkdown.indexOf('Agent prepended this');
    const originalIdx = finalMarkdown.indexOf('Original first paragraph');
    expect(agentIdx).toBeLessThan(originalIdx);

    await conn.disconnect();
  });
});
