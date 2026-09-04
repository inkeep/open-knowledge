import {
  BridgeMergeContentLossError,
  createMergeBoundarySpace,
  MarkdownManager,
  prependFrontmatter,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const USER_TYPING_ORIGIN = {
  source: 'connection' as const,
  context: { origin: 'user-typing' },
};

const FM = '---\ntitle: Boundary alignment\n---\n';
const RAW = `${FM}\nFirst paragraph body.\n\nSecond paragraph stays.\n`;

function canonicalOf(raw: string): string {
  const { frontmatter, body } = stripFrontmatter(raw);
  return prependFrontmatter(frontmatter, mdManager.serialize(mdManager.parseWithFallback(body)));
}

function seedThenAttach(raw: string, docName: string) {
  __resetBridgeWatchdogForTests();
  resetMetrics();
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  doc.transact(() => {
    composeAndWriteRawBody(doc, raw, 'file-watcher');
  }, FILE_WATCHER_ORIGIN);
  const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema, docName });
  return { doc, xmlFragment, ytext, cleanup };
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

function typeIntoSource(doc: Y.Doc, ytext: Y.Text, index: number, ws: string): void {
  doc.transact(() => {
    ytext.insert(index, ws);
  }, USER_TYPING_ORIGIN);
}

describe('Path B doc-boundary alignment: diverged-branch merge fabrication', () => {
  test('precondition: the fixture is round-trip byte-stable', () => {
    expect(canonicalOf(RAW)).toBe(RAW);
  });

  test('first body paragraph is not duplicated; both edits land verbatim', () => {
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(RAW, 'pathb-boundary-dup');
    expect(ytext.toString()).toBe(RAW);

    typeIntoSource(
      doc,
      ytext,
      RAW.indexOf('First paragraph body.') + 'First paragraph body.'.length,
      ' ',
    );
    typeIntoParagraph(doc, xmlFragment, 'First paragraph');

    const finalText = ytext.toString();
    const para1Count = finalText.split('First paragraph body').length - 1;
    expect(para1Count).toBe(1);
    expect(finalText).toContain('ZFirst paragraph body. \n');
    expect(finalText).toContain('Second paragraph stays.');

    cleanup();
  });

  test('the user doc-boundary blank line survives the merge byte-exactly', () => {
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(RAW, 'pathb-boundary-blank');

    typeIntoSource(
      doc,
      ytext,
      RAW.indexOf('First paragraph body.') + 'First paragraph body.'.length,
      ' ',
    );
    typeIntoParagraph(doc, xmlFragment, 'First paragraph');

    const finalText = ytext.toString();
    expect(finalText).toContain('---\n\n');
    expect(finalText).toBe(`${FM}\nZFirst paragraph body. \n\nSecond paragraph stays.\n`);

    cleanup();
  });
});

interface CloseFenceVariant {
  name: string;
  slug: string;
  ws: string;
  editNeedle: string;
  expectedFinal: string;
}

const CLOSE_FENCE_VARIANTS: CloseFenceVariant[] = [
  {
    name: 'trailing space, adjacent WYSIWYG edit',
    slug: 'space-adjacent',
    ws: ' ',
    editNeedle: 'First paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n--- \n\nZFirst paragraph body.\n\nSecond paragraph stays.\n`,
  },
  {
    name: 'trailing tab, adjacent WYSIWYG edit',
    slug: 'tab-adjacent',
    ws: '\t',
    editNeedle: 'First paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n---\t\n\nZFirst paragraph body.\n\nSecond paragraph stays.\n`,
  },
  {
    name: 'trailing space, distal WYSIWYG edit',
    slug: 'space-distal',
    ws: ' ',
    editNeedle: 'Second paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n--- \n\nFirst paragraph body.\n\nZSecond paragraph stays.\n`,
  },
  {
    name: 'trailing tab, distal WYSIWYG edit',
    slug: 'tab-distal',
    ws: '\t',
    editNeedle: 'Second paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n---\t\n\nFirst paragraph body.\n\nZSecond paragraph stays.\n`,
  },
];

describe('Path B doc-boundary alignment: close-fence keystroke byte-exactness', () => {
  for (const variant of CLOSE_FENCE_VARIANTS) {
    test(`${variant.name}: keystroke survives verbatim, no fabricated whitespace`, () => {
      const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(
        RAW,
        `pathb-close-fence-${variant.slug}`,
      );

      typeIntoSource(doc, ytext, RAW.indexOf('\n---\n') + '\n---'.length, variant.ws);
      expect(ytext.toString()).toContain(`---${variant.ws}\n`);

      typeIntoParagraph(doc, xmlFragment, variant.editNeedle);

      const finalText = ytext.toString();
      const closeFence = finalText
        .split('\n')
        .slice(1)
        .find((line) => /^---[ \t]*$/.test(line));
      expect(closeFence).toBe(`---${variant.ws}`);
      expect(finalText).toBe(variant.expectedFinal);

      cleanup();
    });
  }
});

describe('in-sync residual merge (sibling router branch) — byte-preservation guard', () => {
  test('NG-residual doc: WYSIWYG cell edit preserves un-padded table bytes and boundary blank line', () => {
    const rawResidual = `${FM}\n|a|b|\n|-|-|\n|1|2|\n\nSecond paragraph stays.\n`;
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(rawResidual, 'pathb-residual-ng');

    typeIntoParagraph(doc, xmlFragment, 'a');

    expect(ytext.toString()).toBe(`${FM}\n|Za|b|\n|-|-|\n|1|2|\n\nSecond paragraph stays.\n`);

    cleanup();
  });
});

describe('Path B doc-boundary alignment: content-loss recovery arm re-projects the boundary', () => {
  const ENV_KEYS = ['NODE_ENV', 'OK_RETHROW_BRIDGE_LOSS'] as const;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.NODE_ENV = 'production';
    delete process.env.OK_RETHROW_BRIDGE_LOSS;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const FM2 = '---\ntitle: Boundary recovery\n---\n';
  const RAW_NG = `${FM2}First paragraph body.\n\nSecond paragraph stays.\n`;
  const FRAGMENT_WITHOUT_RUN = 'First paragraph body.\n\nSecond paragraph stays.\n';

  test('applies the boundary-reattached as-computed bytes, not raw info.result', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const asComputedMergeSpace = `${FM2}\nZFirst paragraph body. \n\nSecond paragraph stays.\n`;
    const throwingMerge = (): never => {
      throw new BridgeMergeContentLossError({
        baseline: RAW_NG,
        userText: asComputedMergeSpace,
        agentText: RAW_NG,
        result: asComputedMergeSpace,
        lostSubstrings: ['a-dropped-line'],
        which: 'substring',
        side: 'user',
      });
    };

    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    doc.transact(() => {
      composeAndWriteRawBody(doc, RAW_NG, 'file-watcher');
    }, FILE_WATCHER_ORIGIN);
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
      docName: 'pathb-boundary-recovery',
      mergeThreeWay: throwingMerge,
    });
    expect(ytext.toString()).toBe(RAW_NG);

    typeIntoSource(
      doc,
      ytext,
      RAW_NG.indexOf('First paragraph body.') + 'First paragraph body.'.length,
      ' ',
    );
    typeIntoParagraph(doc, xmlFragment, 'First paragraph');

    expect(getMetrics().bridgeMergeContentLoss).toBe(1);

    const finalText = ytext.toString();
    expect(finalText).toContain(`${FM2}Z`);
    const expected = createMergeBoundarySpace(FRAGMENT_WITHOUT_RUN).unproject(
      asComputedMergeSpace,
      RAW_NG,
    );
    expect(finalText).toBe(expected);
    expect(finalText).toBe(`${FM2}ZFirst paragraph body. \n\nSecond paragraph stays.\n`);

    cleanup();
  });

  test('a node-carried doc-start run survives the recovery arm verbatim', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const rawCarried = `${FM2}\n\nFirst paragraph body.\n\nSecond paragraph stays.\n`;
    const asComputedMergeSpace = `${FM2}\n\nZFirst paragraph body. \n\nSecond paragraph stays.\n`;
    const throwingMerge = (): never => {
      throw new BridgeMergeContentLossError({
        baseline: rawCarried,
        userText: asComputedMergeSpace,
        agentText: rawCarried,
        result: asComputedMergeSpace,
        lostSubstrings: ['a-dropped-line'],
        which: 'substring',
        side: 'user',
      });
    };

    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    doc.transact(() => {
      composeAndWriteRawBody(doc, rawCarried, 'file-watcher');
    }, FILE_WATCHER_ORIGIN);
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
      docName: 'pathb-boundary-recovery-carried',
      mergeThreeWay: throwingMerge,
    });
    expect(ytext.toString()).toBe(rawCarried);

    typeIntoSource(
      doc,
      ytext,
      rawCarried.indexOf('First paragraph body.') + 'First paragraph body.'.length,
      ' ',
    );
    typeIntoParagraph(doc, xmlFragment, 'First paragraph');

    expect(getMetrics().bridgeMergeContentLoss).toBe(1);
    expect(ytext.toString()).toBe(asComputedMergeSpace);

    cleanup();
  });
});
