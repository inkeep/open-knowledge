import {
  MarkdownManager,
  prependFrontmatter,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { resetMetrics } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const USER_TYPING_ORIGIN = {
  source: 'connection' as const,
  context: { origin: 'user-typing' },
};

const RAW = '---\ntitle: Fence hazard\n---\n\nFirst paragraph body.\n\nSecond paragraph stays.\n';

function canonicalOf(raw: string): string {
  const { frontmatter, body } = stripFrontmatter(raw);
  return prependFrontmatter(frontmatter, mdManager.serialize(mdManager.parseWithFallback(body)));
}

function seedThenAttach(raw: string, docName: string) {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  doc.transact(() => {
    composeAndWriteRawBody(doc, raw, 'file-watcher');
  }, FILE_WATCHER_ORIGIN);
  const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema, docName });
  return { doc, xmlFragment, ytext, cleanup };
}

function serializeFragmentBody(xmlFragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
}

function findTextNodeContaining(
  node: Y.XmlFragment | Y.XmlElement,
  needle: string,
): Y.XmlText | null {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText && child.toString().includes(needle)) return child;
    if (child instanceof Y.XmlElement) {
      const found = findTextNodeContaining(child, needle);
      if (found) return found;
    }
  }
  return null;
}

function typeIntoParagraph(doc: Y.Doc, xmlFragment: Y.XmlFragment, needle: string): void {
  doc.transact(() => {
    const textNode = findTextNodeContaining(xmlFragment, needle);
    if (!textNode) throw new Error(`no fragment text node containing ${JSON.stringify(needle)}`);
    textNode.insert(0, 'Z');
  }, USER_TYPING_ORIGIN);
}

function captureBridgeEvents(eventName: string, fn: () => void): Record<string, unknown>[] {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnings
    .map((w) => {
      try {
        return JSON.parse(w);
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null)
    .filter((e) => e.event === eventName);
}

interface FenceVariant {
  name: string;
  slug: string;
  ws: string;
  fence: 'open' | 'close';
  insertAt: (s: string) => number;
}

const endOfOpeningFence = (s: string): number => s.indexOf('\n');
const endOfClosingFence = (s: string): number => s.indexOf('\n---\n') + '\n---'.length;

const FENCE_VARIANTS: FenceVariant[] = [
  {
    name: 'trailing space on the opening fence',
    slug: 'open-space',
    ws: ' ',
    fence: 'open',
    insertAt: endOfOpeningFence,
  },
  {
    name: 'trailing space on the closing fence',
    slug: 'close-space',
    ws: ' ',
    fence: 'close',
    insertAt: endOfClosingFence,
  },
  {
    name: 'trailing tab on the opening fence',
    slug: 'open-tab',
    ws: '\t',
    fence: 'open',
    insertAt: endOfOpeningFence,
  },
  {
    name: 'trailing tab on the closing fence',
    slug: 'close-tab',
    ws: '\t',
    fence: 'close',
    insertAt: endOfClosingFence,
  },
];

describe('FM-fence trailing whitespace + adjacent WYSIWYG edit', () => {
  test('precondition: the fixture is round-trip byte-stable', () => {
    expect(canonicalOf(RAW)).toBe(RAW);
  });

  for (const variant of FENCE_VARIANTS) {
    test(`${variant.name}: FM survives, keystroke kept, edit applied`, () => {
      __resetBridgeWatchdogForTests();
      resetMetrics();
      const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(
        RAW,
        `fm-fence-adjacent-${variant.slug}`,
      );
      expect(ytext.toString()).toBe(RAW);

      doc.transact(() => {
        ytext.insert(variant.insertAt(ytext.toString()), variant.ws);
      }, USER_TYPING_ORIGIN);
      expect(ytext.toString()).toContain(`---${variant.ws}\n`);

      typeIntoParagraph(doc, xmlFragment, 'First paragraph');

      const finalText = ytext.toString();
      expect(finalText).toContain('title: Fence hazard');
      if (variant.fence === 'open') {
        expect(finalText).toContain(`---${variant.ws}\n`);
      } else {
        const closeFence = finalText
          .split('\n')
          .slice(1)
          .find((line) => /^---[ \t]*$/.test(line));
        expect(closeFence).toMatch(/^---[ \t]+$/);
        expect(closeFence).toContain(variant.ws);
      }
      expect(finalText).toContain('ZFirst paragraph body.');
      expect(finalText).toContain('Second paragraph stays.');
      expect(serializeFragmentBody(xmlFragment)).not.toContain('title: Fence hazard');

      cleanup();
    });
  }
});

describe('FM-fence trailing whitespace + distal WYSIWYG edit', () => {
  for (const variant of FENCE_VARIANTS) {
    test(`${variant.name}: doc settles coherently, FM keeps partitioning as FM`, () => {
      __resetBridgeWatchdogForTests();
      resetMetrics();
      const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(
        RAW,
        `fm-fence-distal-${variant.slug}`,
      );

      doc.transact(() => {
        ytext.insert(variant.insertAt(ytext.toString()), variant.ws);
      }, USER_TYPING_ORIGIN);

      const splitBrainEvents = captureBridgeEvents('bridge-split-brain-rederive', () => {
        typeIntoParagraph(doc, xmlFragment, 'Second paragraph');
      });
      expect(splitBrainEvents).toHaveLength(0);

      const finalText = ytext.toString();
      expect(finalText).toContain('title: Fence hazard');
      if (variant.fence === 'open') {
        expect(finalText).toContain(`---${variant.ws}\n`);
      } else {
        const closeFence = finalText
          .split('\n')
          .slice(1)
          .find((line) => /^---[ \t]*$/.test(line));
        expect(closeFence).toMatch(/^---[ \t]+$/);
        expect(closeFence).toContain(variant.ws);
      }
      expect(finalText).toContain('ZSecond paragraph stays.');
      expect(finalText).toContain('First paragraph body.');
      expect(serializeFragmentBody(xmlFragment)).not.toContain('title: Fence hazard');

      cleanup();
    });
  }
});
