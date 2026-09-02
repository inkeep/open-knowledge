import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  loadMermaidDoc,
  MERMAID_SOURCE_ORIGIN,
  type MermaidPersistenceCtx,
  storeMermaidDoc,
} from './mermaid-persistence.ts';

let contentDir: string;

function makeCtx(): MermaidPersistenceCtx {
  return { contentDir, lkgCache: new Map<string, string>() };
}

const DOC = 'assets/flow.mmd';
const ABS = () => resolve(contentDir, DOC);
const SRC = 'graph TD;\n  A[Start] --> B{Choice};\n  B -->|Yes| C[Go];\n';

function writeMmd(content: string): void {
  mkdirSync(dirname(ABS()), { recursive: true });
  writeFileSync(ABS(), content, 'utf-8');
}

beforeEach(() => {
  contentDir = mkdtempSync(join(tmpdir(), 'ok-mermaid-'));
});
afterEach(() => {
  rmSync(contentDir, { recursive: true, force: true });
});

describe('storeMermaidDoc', () => {
  test('persists Y.Text("source") verbatim to the .mmd file', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(ABS(), 'utf-8')).toBe(SRC);
  });

  test('stores source with markdown-syntactic + blank-line content byte-for-byte (no remark round-trip)', async () => {
    const ctx = makeCtx();
    const awkward = '## not a heading\n\n\n> not a quote  \ngraph LR; A-->B;\n';
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, awkward), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(ABS(), 'utf-8')).toBe(awkward);
  });

  test('no-op when the store originates from a seed/reconcile import (skip-store origin)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, MERMAID_SOURCE_ORIGIN, ctx)).toBe('no-op');
  });

  test('no-op on the second identical store (LKG equality guard)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('no-op');
  });

  test('reconciles (imports disk) instead of clobbering when an external writer diverged from LKG', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');

    const external = 'sequenceDiagram; Alice->>Bob: Hi;\n';
    writeMmd(external);

    doc.transact(() => {
      const yt = doc.getText('source');
      yt.delete(0, yt.length);
      yt.insert(0, 'graph TD; X-->Y;\n');
    }, 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('reconciled');
    expect(doc.getText('source').toString()).toBe(external);
    expect(readFileSync(ABS(), 'utf-8')).toBe(external);
    expect(ctx.lkgCache.get(DOC)).toBe(external);
  });
});

describe('loadMermaidDoc', () => {
  test('seeds Y.Text("source") from disk and mints a lineage epoch', () => {
    writeMmd(SRC);
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadMermaidDoc(doc, DOC, ctx);
    expect(doc.getText('source').toString()).toBe(SRC);
    expect(typeof doc.getMap('lifecycle').get(LINEAGE_EPOCH_KEY)).toBe('string');
    expect(doc.getXmlFragment('default').length).toBe(0);
  });

  test('lazy: a missing file seeds nothing (admitting a doc never creates disk)', () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadMermaidDoc(doc, DOC, ctx);
    expect(doc.getText('source').toString()).toBe('');
  });

  test('idempotent: does not re-seed when Y.Text is already populated', () => {
    writeMmd(SRC);
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, 'pre-existing'), 'agent');
    loadMermaidDoc(doc, DOC, ctx);
    expect(doc.getText('source').toString()).toBe('pre-existing');
  });

  test('round-trips store → load through disk unchanged', async () => {
    const ctx = makeCtx();
    const writeDoc = new Y.Doc();
    writeDoc.transact(() => writeDoc.getText('source').insert(0, SRC), 'agent');
    await storeMermaidDoc(writeDoc, DOC, 'agent', ctx);

    const readDoc = new Y.Doc();
    loadMermaidDoc(readDoc, DOC, makeCtx());
    expect(readDoc.getText('source').toString()).toBe(SRC);
  });
});

describe('editable text docs on the verbatim path', () => {
  const TS_DOC = 'src/util.ts';
  const TS_SRC = `export function greet(name: string): string {\n\n  return \`hello $\{name}\`;\n}\n`;

  test('loads a .ts file verbatim into Y.Text("source")', () => {
    mkdirSync(dirname(resolve(contentDir, TS_DOC)), { recursive: true });
    writeFileSync(resolve(contentDir, TS_DOC), TS_SRC, 'utf-8');
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadMermaidDoc(doc, TS_DOC, ctx);
    expect(doc.getText('source').toString()).toBe(TS_SRC);
  });

  test('stores edited .ts bytes back verbatim (no markdown canonicalization)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, TS_SRC), 'agent');
    expect(await storeMermaidDoc(doc, TS_DOC, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(resolve(contentDir, TS_DOC), 'utf-8')).toBe(TS_SRC);
  });
});
