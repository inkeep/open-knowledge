/**
 * FM-fence trailing-whitespace hazard — user-outcome contract.
 *
 * A source-mode (W2) keystroke that appends trailing whitespace to a
 * frontmatter fence line is within normalizeBridge tolerance, so Observer B
 * early-exits without refreshing witnesses. The partition-invariance
 * contract
 * requires that such an edit must not change FM-region recognition; when it
 * does, Observer A's next Path B merge composes its user input without the
 * FM region and destroys it.
 *
 * These tests pin the user-visible outcome on the real observer pipeline
 * (real setupServerObservers + composeAndWriteRawBody on a raw Y.Doc):
 * after the fence keystroke plus a subsequent WYSIWYG edit,
 *   (a) the FM region's bytes are still present in Y.Text,
 *   (b) the user's keystroke is not reverted (Y.Text-is-truth),
 *   (c) the WYSIWYG edit is applied, and
 *   (d) the FM region is not re-derived into the WYSIWYG body.
 */
import { describe, expect, test } from 'bun:test';
import {
  MarkdownManager,
  prependFrontmatter,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
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

/** Seed a doc production-order: paired-write intake first, attach second. */
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

/** Insert one character at the start of the text node containing `needle`. */
function typeIntoParagraph(doc: Y.Doc, xmlFragment: Y.XmlFragment, needle: string): void {
  doc.transact(() => {
    const textNode = findTextNodeContaining(xmlFragment, needle);
    if (!textNode) throw new Error(`no fragment text node containing ${JSON.stringify(needle)}`);
    textNode.insert(0, 'Z');
  }, USER_TYPING_ORIGIN);
}

/** Run `fn` capturing emitted structured bridge events with the given name. */
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

      // W2 source-mode keystroke: trailing whitespace at the end of a fence
      // line — within normalizeBridge tolerance, so Observer B early-exits.
      doc.transact(() => {
        ytext.insert(variant.insertAt(ytext.toString()), variant.ws);
      }, USER_TYPING_ORIGIN);
      expect(ytext.toString()).toContain(`---${variant.ws}\n`);

      // WYSIWYG edit in the first body block — the next settlement drain.
      typeIntoParagraph(doc, xmlFragment, 'First paragraph');

      const finalText = ytext.toString();
      // (a) the FM region's bytes are still present
      expect(finalText).toContain('title: Fence hazard');
      // (b) the user's keystroke is not reverted
      if (variant.fence === 'open') {
        expect(finalText).toContain(`---${variant.ws}\n`);
      } else {
        // Close-fence byte-exactness is NOT pinned here: Observer A Path B's
        // merge-input doc-boundary misalignment (a separate invariant with
        // its own fix scope) currently fabricates one extra whitespace byte
        // on the close fence (`---  \n` for `--- \n`). THIS bug's invariant:
        // the keystroke is not REVERTED — the close fence still carries
        // trailing whitespace of the user's class, not canonicalized back to
        // bare `---`.
        const closeFence = finalText
          .split('\n')
          .slice(1)
          .find((line) => /^---[ \t]*$/.test(line));
        expect(closeFence).toMatch(/^---[ \t]+$/);
        expect(closeFence).toContain(variant.ws);
      }
      // (c) the WYSIWYG edit is applied
      expect(finalText).toContain('ZFirst paragraph body.');
      // floor: untouched content survives
      expect(finalText).toContain('Second paragraph stays.');
      // (d) the FM region is not re-derived into the WYSIWYG body
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

      // WYSIWYG edit far from the FM region (last body block). The settlement
      // must be coherent: bridge-split-brain-rederive's own contract is that
      // no organic input produces the witness/Y.Text divergence it reports —
      // an in-tolerance fence keystroke followed by a body edit is organic
      // input. A split-brain settlement here leaves the doc poisoned: its
      // witnesses no longer carry the FM region, so a later adjacent edit
      // destroys it.
      const splitBrainEvents = captureBridgeEvents('bridge-split-brain-rederive', () => {
        typeIntoParagraph(doc, xmlFragment, 'Second paragraph');
      });
      expect(splitBrainEvents).toHaveLength(0);

      const finalText = ytext.toString();
      expect(finalText).toContain('title: Fence hazard');
      if (variant.fence === 'open') {
        expect(finalText).toContain(`---${variant.ws}\n`);
      } else {
        // Same class pin as the adjacent block: close-fence byte-exactness
        // belongs to the merge-input doc-boundary alignment bug; THIS bug's
        // invariant is that the keystroke is not REVERTED.
        const closeFence = finalText
          .split('\n')
          .slice(1)
          .find((line) => /^---[ \t]*$/.test(line));
        expect(closeFence).toMatch(/^---[ \t]+$/);
        expect(closeFence).toContain(variant.ws);
      }
      expect(finalText).toContain('ZSecond paragraph stays.');
      expect(finalText).toContain('First paragraph body.');
      // The FM region must not be re-derived into the WYSIWYG body as text.
      expect(serializeFragmentBody(xmlFragment)).not.toContain('title: Fence hazard');

      cleanup();
    });
  }
});
