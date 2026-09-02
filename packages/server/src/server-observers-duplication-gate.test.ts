import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { findRaceDuplicatedSpans } from './server-observers.ts';

function makeChild(nodeName: string, text: string): Y.XmlElement {
  const el = new Y.XmlElement(nodeName);
  el.insert(0, [new Y.XmlText(text)]);
  return el;
}

function mergeInto(target: Y.Doc, source: Y.Doc): void {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
}

describe('findRaceDuplicatedSpans', () => {
  const LINE = 'Step one body line.';

  test('server-minted jsxComponent + foreign-minted rawMdxFallback carrying the same line is a race', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const sFrag = server.getXmlFragment('default');
    server.transact(() => sFrag.insert(0, [makeChild('jsxComponent', LINE)]));
    client.transact(() =>
      client.getXmlFragment('default').insert(0, [makeChild('rawMdxFallback', LINE)]),
    );
    mergeInto(server, client);

    expect(sFrag.length).toBe(2);
    expect(findRaceDuplicatedSpans(sFrag, server.clientID, [LINE])).toBe(true);
  });

  test('two foreign-minted carriers (paste-twice shape) is NOT a race', () => {
    const server = new Y.Doc();
    const c1 = new Y.Doc();
    const c2 = new Y.Doc();
    const sFrag = server.getXmlFragment('default');
    c1.transact(() => c1.getXmlFragment('default').insert(0, [makeChild('paragraph', LINE)]));
    c2.transact(() => c2.getXmlFragment('default').insert(0, [makeChild('paragraph', LINE)]));
    mergeInto(server, c1);
    mergeInto(server, c2);

    expect(sFrag.length).toBe(2);
    expect(findRaceDuplicatedSpans(sFrag, server.clientID, [LINE])).toBe(false);
  });

  test('server-minted + foreign-minted carriers of the SAME node type is NOT a race', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const sFrag = server.getXmlFragment('default');
    server.transact(() => sFrag.insert(0, [makeChild('jsxComponent', LINE)]));
    client.transact(() =>
      client.getXmlFragment('default').insert(0, [makeChild('jsxComponent', LINE)]),
    );
    mergeInto(server, client);

    expect(sFrag.length).toBe(2);
    expect(findRaceDuplicatedSpans(sFrag, server.clientID, [LINE])).toBe(false);
  });

  test('inline-formatted line still attributes carriers (markdown vs XML normalization agrees)', () => {
    const mdLine = 'Run `code_with_underscore` on the snake_case_name path now.';
    const xmlText = 'Run code_with_underscore on the snake_case_name path now.';
    const server = new Y.Doc();
    const client = new Y.Doc();
    const sFrag = server.getXmlFragment('default');
    server.transact(() => sFrag.insert(0, [makeChild('jsxComponent', xmlText)]));
    client.transact(() =>
      client.getXmlFragment('default').insert(0, [makeChild('rawMdxFallback', xmlText)]),
    );
    mergeInto(server, client);

    expect(sFrag.length).toBe(2);
    expect(findRaceDuplicatedSpans(sFrag, server.clientID, [mdLine])).toBe(true);
  });

  test('a lone server-minted carrier is NOT a race (no foreign sibling)', () => {
    const server = new Y.Doc();
    const sFrag = server.getXmlFragment('default');
    server.transact(() => sFrag.insert(0, [makeChild('jsxComponent', LINE)]));
    expect(findRaceDuplicatedSpans(sFrag, server.clientID, [LINE])).toBe(false);
  });

  test('empty over-multiplied line set short-circuits to NOT a race', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const sFrag = server.getXmlFragment('default');
    server.transact(() => sFrag.insert(0, [makeChild('jsxComponent', LINE)]));
    client.transact(() =>
      client.getXmlFragment('default').insert(0, [makeChild('rawMdxFallback', LINE)]),
    );
    mergeInto(server, client);
    expect(findRaceDuplicatedSpans(sFrag, server.clientID, [])).toBe(false);
  });
});
