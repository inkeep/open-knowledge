import {
  type JSONContent,
  MarkdownManager,
  type SerializeCallOptions,
  sharedExtensions,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { type SetupServerObserversOpts, setupServerObservers } from './server-observers.ts';

const schema = getSchema(sharedExtensions);

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const GEN2 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one body.\n\n</Step>\n\n</Steps>\n';

type J = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: J[] };

function mutateFirstText(node: J, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

function makeRecordingManager(): {
  manager: MarkdownManager;
  serializeOpts: Array<SerializeCallOptions | undefined>;
} {
  const real = new MarkdownManager({
    extensions: sharedExtensions,
    deriveStructuralFreshness: true,
  });
  const serializeOpts: Array<SerializeCallOptions | undefined> = [];
  const manager = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return (json: JSONContent, opts?: SerializeCallOptions) => {
          serializeOpts.push(opts);
          return target.serialize(json, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { manager, serializeOpts };
}

describe('Observer A — freshness suppression on diverged-baseline drains', () => {
  test('settled drain serializes WITH freshness; diverged drain suppresses it; bytes converge to truth', () => {
    const { manager, serializeOpts } = makeRecordingManager();
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager: manager,
      schema,
      docName: 'respell-suppression.md',
    } as SetupServerObserversOpts);
    try {
      const gen1Node = schema.nodeFromJSON(manager.parse(GEN1));
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, gen1Node, { mapping: new Map(), isOMark: new Map() });
      }, null);
      expect(ytext.toString()).toContain('Step one bod');
      expect(serializeOpts.some((o) => o?.skipFreshnessDerive === false)).toBe(true);
      expect(serializeOpts.some((o) => o?.skipFreshnessDerive === true)).toBe(false);

      const echoTree = manager.parse(GEN1) as J;
      if (!mutateFirstText(echoTree, 'Step one bod', 'Step one body.')) {
        throw new Error('staging failed: interior leaf not found');
      }
      const echoNode = schema.nodeFromJSON(echoTree as JSONContent);

      const before = serializeOpts.length;
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, echoNode, { mapping: new Map(), isOMark: new Map() });
        ytext.delete(0, ytext.length);
        ytext.insert(0, GEN2);
      }, null);

      const divergedCalls = serializeOpts.slice(before);
      expect(divergedCalls.length).toBeGreaterThan(0);
      expect(divergedCalls.some((o) => o?.skipFreshnessDerive === true)).toBe(true);

      const finalText = ytext.toString();
      expect((finalText.match(/Step one body\./g) ?? []).length).toBe(1);
      expect((finalText.match(/<Steps>/g) ?? []).length).toBe(1);
      expect((finalText.match(/<Step>/g) ?? []).length).toBe(1);
      expect(finalText).not.toContain('body.y');
      expect(/\n[ \t]+<Step\b/.test(finalText)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('a recent EXTERNAL Y.Text write suppresses freshness even on a witness-coherent drain, until the quiescence window passes', () => {
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const { manager, serializeOpts } = makeRecordingManager();
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager: manager,
      schema,
      docName: 'quiescence.md',
    } as SetupServerObserversOpts);
    try {
      const gen1Node = schema.nodeFromJSON(manager.parse(GEN1));
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, gen1Node, { mapping: new Map(), isOMark: new Map() });
      }, null);

      doc.transact(() => {
        ytext.insert(ytext.length, '\nTrailing.\n');
      }, 'external-peer');

      clock += 500;
      const insideWindowStart = serializeOpts.length;
      const echoTree = manager.parse(ytext.toString()) as J;
      if (!mutateFirstText(echoTree, 'Step one bod', 'Step one bod!')) {
        throw new Error('staging failed: interior leaf not found');
      }
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, schema.nodeFromJSON(echoTree as JSONContent), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      }, null);
      const insideWindow = serializeOpts.slice(insideWindowStart);
      expect(insideWindow.length).toBeGreaterThan(0);
      expect(insideWindow.some((o) => o?.skipFreshnessDerive === true)).toBe(true);

      clock += 10_000;
      const afterWindowStart = serializeOpts.length;
      const laterTree = manager.parse(ytext.toString()) as J;
      if (!mutateFirstText(laterTree, 'Step one bod', 'Step one bod?')) {
        throw new Error('staging failed: interior leaf not found (second)');
      }
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, schema.nodeFromJSON(laterTree as JSONContent), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      }, null);
      const afterWindow = serializeOpts.slice(afterWindowStart);
      expect(afterWindow.length).toBeGreaterThan(0);
      expect(afterWindow.some((o) => o?.skipFreshnessDerive === false)).toBe(true);
    } finally {
      nowSpy.mockRestore();
      cleanup();
    }
  });
});
