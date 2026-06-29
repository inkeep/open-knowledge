import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { type ObserverDispatchKind, setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const CLIENT_ORIGIN = { client: 'simulated-y-prosemirror-client' };

const SOURCE = 'Para one.\n\n<Foo>broken</Bar>\n\nPara two.\n';
const BROKEN_BLOCK = '<Foo>broken</Bar>';


const ENV_KEYS = ['NODE_ENV', 'OK_BRIDGE_THROW_ON_VIOLATION', 'OK_RETHROW_BRIDGE_LOSS'] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.NODE_ENV = 'production';
  delete process.env.OK_BRIDGE_THROW_ON_VIOLATION;
  delete process.env.OK_RETHROW_BRIDGE_LOSS;
  resetMetrics();
  __resetBridgeWatchdogForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});


interface PmJson {
  type: string;
  content?: PmJson[];
  text?: string;
  attrs?: Record<string, unknown>;
}

function findFallback(node: PmJson): PmJson | null {
  if (node.type === 'rawMdxFallback') return node;
  for (const child of node.content ?? []) {
    const hit = findFallback(child);
    if (hit) return hit;
  }
  return null;
}

function fragmentJson(xmlFragment: Y.XmlFragment): PmJson {
  return yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON() as PmJson;
}

function writeFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, json: PmJson): void {
  const pmNode = schema.nodeFromJSON(json);
  doc.transact(() => {
    const meta = { mapping: new Map(), isOMark: new Map() };
    updateYFragment(doc, xmlFragment, pmNode, meta);
  }, CLIENT_ORIGIN);
}


type DivergenceShape = (fallback: PmJson) => void;

const guardEmptyShape: DivergenceShape = (fallback) => {
  fallback.content = [];
};

const sentinelShape: DivergenceShape = (fallback) => {
  fallback.content = [{ type: 'text', text: '«unknown:someFutureType»' }];
};

function makeSerializeFault() {
  let armed = 0;
  let fired = false;
  return {
    arm(times = 1) {
      armed = times;
    },
    get fired() {
      return fired;
    },
    maybeThrow() {
      if (armed > 0) {
        armed -= 1;
        fired = true;
        throw new Error('injected serialize failure');
      }
    },
  };
}
type SerializeFault = ReturnType<typeof makeSerializeFault>;

function makeDegradedManager(diverge: DivergenceShape, fault?: SerializeFault): MarkdownManager {
  return new Proxy(mdManager, {
    get(target, prop, receiver) {
      if (prop === 'parseWithFallback') {
        return (markdown: string, opts?: Parameters<MarkdownManager['parseWithFallback']>[1]) => {
          const json = target.parseWithFallback(markdown, opts) as PmJson;
          const fallback = findFallback(json);
          if (fallback) diverge(fallback);
          return json;
        };
      }
      if (prop === 'serialize' && fault) {
        return (json: Parameters<MarkdownManager['serialize']>[0]) => {
          fault.maybeThrow();
          return target.serialize(json);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}


function loadDivergentDoc(
  diverge: DivergenceShape,
  onDispatch?: (kind: ObserverDispatchKind) => void,
  fault?: SerializeFault,
) {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  const cleanup = setupServerObservers({
    doc,
    xmlFragment,
    ytext,
    mdManager: makeDegradedManager(diverge, fault),
    schema,
    onDispatch,
  });
  doc.transact(() => {
    ytext.insert(0, SOURCE);
  }, CLIENT_ORIGIN);
  return { doc, xmlFragment, ytext, cleanup };
}

async function quiesce(xmlFragment: Y.XmlFragment, ytext: Y.Text): Promise<void> {
  const snapshot = () => `${JSON.stringify(fragmentJson(xmlFragment))}\n${ytext.toString()}`;
  let prev = snapshot();
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = snapshot();
    if (current === prev) return;
    prev = current;
  }
}

function typeIntoFallback(doc: Y.Doc, xmlFragment: Y.XmlFragment, char: string): void {
  const json = fragmentJson(xmlFragment);
  const fallback = findFallback(json);
  if (!fallback) throw new Error('expected a rawMdxFallback node in the fragment');
  const current = (fallback.content ?? []).map((child) => child.text ?? '').join('');
  fallback.content = [{ type: 'text', text: current + char }];
  writeFragment(doc, xmlFragment, json);
}

function appendToLastParagraph(doc: Y.Doc, xmlFragment: Y.XmlFragment, suffix: string): void {
  const json = fragmentJson(xmlFragment);
  const last = json.content?.[json.content.length - 1];
  const textNode = last?.content?.[0];
  if (!textNode?.text) throw new Error('expected trailing paragraph text');
  textNode.text += suffix;
  writeFragment(doc, xmlFragment, json);
}


describe('divergent rawMdxFallback must not become authoritative source', () => {
  test('S4: typing twice into a divergent fallback preserves the source bytes it stands for', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    typeIntoFallback(doc, xmlFragment, 'y');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('Para one.');
    expect(after).toContain('Para two.');

    cleanup();
  });

  test('protective re-derive dispatches a-then-b within the same drain', () => {
    const dispatches: ObserverDispatchKind[] = [];
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape, (kind) =>
      dispatches.push(kind),
    );

    dispatches.length = 0;
    resetMetrics();
    __resetBridgeWatchdogForTests();
    typeIntoFallback(doc, xmlFragment, 'x');

    const userDispatches = dispatches.filter((kind) => kind !== 'none');
    expect(userDispatches).toEqual(['a', 'b']);
    expect(ytext.toString()).toContain(BROKEN_BLOCK);
    expect(getMetrics().bridgeSplitBrainRederives).toBe(1);

    cleanup();
  });

  test('S4 sentinel producer: «unknown:type»-shaped divergence is equally protected', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(sentinelShape);

    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    typeIntoFallback(doc, xmlFragment, 'y');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after).not.toContain('«unknown:someFutureType»');

    cleanup();
  });

  test('S6: one fallback keystroke then an ordinary edit elsewhere preserves the source bytes', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('EDITED');

    cleanup();
  });

  test('S5: blur-upgrade on an empty divergent fallback keeps Y.Text intact and keeps the broken-block chrome', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    const upgraded = mdManager.parseWithFallback('') as PmJson;
    const json = fragmentJson(xmlFragment);
    const fallback = findFallback(json);
    if (!fallback) throw new Error('expected a rawMdxFallback node in the fragment');
    const index = json.content?.indexOf(fallback) ?? -1;
    if (index < 0 || !json.content || !upgraded.content) {
      throw new Error('expected top-level fallback and upgrade content');
    }
    json.content.splice(index, 1, ...upgraded.content);
    writeFragment(doc, xmlFragment, json);
    await quiesce(xmlFragment, ytext);

    expect(ytext.toString()).toBe(SOURCE);
    expect(findFallback(fragmentJson(xmlFragment))).not.toBeNull();

    cleanup();
  });

  test('S3 bound: a divergent fallback at rest is safe — an edit elsewhere alone merges cleanly', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    expect(ytext.toString()).toBe(SOURCE.replace('Para two.', 'Para two. EDITED'));

    cleanup();
  });

  test('error-recovery: a serialize throw during a fallback drain must not let the baseline reset destroy the source bytes', async () => {
    const fault = makeSerializeFault();
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(
      guardEmptyShape,
      undefined,
      fault,
    );

    fault.arm();
    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    expect(fault.fired).toBe(true);

    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('Para one.');
    expect(after).toContain('EDITED');

    cleanup();
  });

  test('error-recovery double failure: when the recovery serialize also throws, the next drain still preserves the source bytes', async () => {
    const fault = makeSerializeFault();
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(
      guardEmptyShape,
      undefined,
      fault,
    );

    fault.arm(2);
    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    expect(fault.fired).toBe(true);

    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('Para one.');
    expect(after).toContain('EDITED');

    cleanup();
  });

  test('identity-gate dispatch pin: blur-upgrade fires a same-drain a-then-b re-derive with one counted emission', async () => {
    const dispatches: ObserverDispatchKind[] = [];
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape, (kind) =>
      dispatches.push(kind),
    );

    const upgraded = mdManager.parseWithFallback('') as PmJson;
    const json = fragmentJson(xmlFragment);
    const fallback = findFallback(json);
    if (!fallback) throw new Error('expected a rawMdxFallback node in the fragment');
    const index = json.content?.indexOf(fallback) ?? -1;
    if (index < 0 || !json.content || !upgraded.content) {
      throw new Error('expected top-level fallback and upgrade content');
    }
    json.content.splice(index, 1, ...upgraded.content);

    dispatches.length = 0;
    resetMetrics();
    __resetBridgeWatchdogForTests();
    writeFragment(doc, xmlFragment, json);

    const userDispatches = dispatches.filter((kind) => kind !== 'none');
    expect(userDispatches).toEqual(['a', 'b']);
    expect(getMetrics().bridgeSplitBrainRederives).toBe(1);
    expect(findFallback(fragmentJson(xmlFragment))).not.toBeNull();
    expect(ytext.toString()).toBe(SOURCE);

    cleanup();
  });
});
