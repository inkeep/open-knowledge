/**
 * CONTRACT — byte-sacred typing inside indented MDX-JSX regions.
 *
 * A source-mode keystroke, or a WYSIWYG-side body edit, inside an INDENTED
 * MDX-JSX region (a <Step> nested in <Steps> with leading indentation on the
 * tags) must NOT trigger a normalizing (de-indent) write-back into Y.Text.
 * Server Observer A is the only surface allowed to canonicalize, and it must
 * leave the raw indented bytes intact (per-write-path fidelity: byte-writer
 * paths land verbatim). A de-indent / normalization write-back is a fidelity
 * regression.
 *
 * Shape B (the whole <Steps> container indented) is the sentinel: it rests
 * BEYOND normalizeBridge tolerance, so its raw bytes and their canonical
 * serialization are not normalize-equal — the highest write-back-risk shape.
 * Byte-sacred must still hold for it.
 *
 */

import { setTimeout as wait } from 'node:timers/promises';
import { normalizeBridge } from '@inkeep/open-knowledge-core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  mdManager,
  schema,
  type TestClient,
  type TestServer,
} from './test-harness';

/** A genuine WYSIWYG-side fragment commit (null origin => server Observer A
 *  sees a real WYSIWYG mutation, xmlDirty=true). */
function applyWysiwygEdit(client: TestClient, markdownAfterEdit: string): void {
  const pmNode = schema.nodeFromJSON(mdManager.parse(markdownAfterEdit));
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

// Indented-JSX shapes (leading indentation ON the tags).

// Shape A: flush-left <Steps>, 2-space-indented <Step>/</Step> tags + bodies.
const SHAPE_A_INDENTED_STEP = [
  '<Steps>',
  '',
  '  <Step>',
  '',
  '  Content one.',
  '',
  '  </Step>',
  '',
  '  <Step>',
  '',
  '  Content two.',
  '',
  '  </Step>',
  '',
  '</Steps>',
  '',
].join('\n');

// Shape B: the ENTIRE container indented 2 spaces (every tag + body).
const SHAPE_B_INDENTED_CONTAINER = [
  '  <Steps>',
  '',
  '  <Step>',
  '',
  '  Content one.',
  '',
  '  </Step>',
  '',
  '  </Steps>',
  '',
].join('\n');

// Shape C: 3-space-indented <Step> tags (an odd indent below CommonMark's
// 4-space indented-code boundary).
const SHAPE_C_THREE_SPACE = [
  '<Steps>',
  '',
  '   <Step>',
  '',
  '   Content one.',
  '',
  '   </Step>',
  '',
  '</Steps>',
  '',
].join('\n');

interface Shape {
  name: string;
  seed: string;
  anchor: string;
  /** Measured serialize/tolerance characterization the byte-sacred guarantee
   *  rests on. Shape B is the sentinel: NOT a serialize fixed point AND beyond
   *  normalizeBridge tolerance, yet byte-sacred still holds. */
  isFixedPoint: boolean;
  withinTolerance: boolean;
}

const SHAPES: Shape[] = [
  {
    name: 'A: indented <Step> tags (2-space)',
    seed: SHAPE_A_INDENTED_STEP,
    anchor: 'Content one',
    isFixedPoint: true,
    withinTolerance: true,
  },
  {
    name: 'B: fully-indented <Steps> container (2-space)',
    seed: SHAPE_B_INDENTED_CONTAINER,
    anchor: 'Content one',
    isFixedPoint: false,
    withinTolerance: false,
  },
  {
    name: 'C: indented <Step> tags (3-space)',
    seed: SHAPE_C_THREE_SPACE,
    anchor: 'Content one',
    isFixedPoint: true,
    withinTolerance: true,
  },
];

describe('indented-JSX serialize + normalizeBridge tolerance characterization', () => {
  for (const shape of SHAPES) {
    test(`${shape.name}: serialize fixed-point + normalizeBridge tolerance are stable`, () => {
      const canonical = mdManager.serialize(mdManager.parse(shape.seed));
      const isFixedPoint = canonical === shape.seed;
      const withinTolerance = normalizeBridge(shape.seed) === normalizeBridge(canonical);
      expect(isFixedPoint).toBe(shape.isFixedPoint);
      expect(withinTolerance).toBe(shape.withinTolerance);
    });
  }
});

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('byte-sacred source-mode typing inside indented JSX', () => {
  for (const { name, seed, anchor } of SHAPES) {
    test(`${name}: a source-mode keystroke stays byte-verbatim (no Observer-A normalization write-back)`, async () => {
      const docName = `e2-${name.replace(/[^a-z0-9]/gi, '-')}-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        const ytext = client.doc.getText('source');
        await awaitDocQuiescence(client.doc);
        const landed = ytext.toString();

        // Simulate a source-mode keystroke: a client-origin Y.Text insert (the
        // default transaction origin is NOT a paired write origin — it is the
        // CM6/source-typing channel). Insert INSIDE the indented region.
        const at = landed.indexOf(anchor) + anchor.length;
        expect(at).toBeGreaterThan(anchor.length); // anchor exists in landed bytes
        client.doc.transact(() => ytext.insert(at, 'X'));
        const expectedAfterTyping = ytext.toString(); // exactly the typed bytes
        await awaitDocQuiescence(client.doc);

        const serverBytes = getServerState(server, docName)?.ytext.toString() ?? '';
        // The server's raw Y.Text must equal EXACTLY the typed bytes. Any
        // de-indent / normalization write-back reddens here.
        expect(serverBytes).toBe(expectedAfterTyping);
      } finally {
        await client.cleanup();
      }
    });
  }
});

// The indented-JSX write-back risk names the hidden-but-mounted WYSIWYG TipTap
// binding as the single-client trigger. Cover that channel (a fragment commit,
// xmlDirty) on the two shapes whose indentation survives landing — including
// Shape B, which rests beyond normalizeBridge tolerance (the highest risk).
const WYSIWYG_SHAPES = SHAPES.filter((s) => s.name.startsWith('A') || s.name.startsWith('B'));

describe('byte-sacred WYSIWYG-commit channel on indented JSX', () => {
  for (const { name, seed } of WYSIWYG_SHAPES) {
    test(`${name}: a WYSIWYG fragment commit does not re-indent / normalize the container in Y.Text`, async () => {
      const docName = `e2w-${name.replace(/[^a-z0-9]/gi, '-')}-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        const ytext = client.doc.getText('source');
        await awaitDocQuiescence(client.doc);
        const landed = ytext.toString();
        expect(landed).toBe(seed); // indented seed landed verbatim

        // Genuine WYSIWYG-side change (fires Observer A with xmlDirty): edit the
        // body text of the first Step.
        applyWysiwygEdit(client, landed.replace('Content one.', 'Content one, edited.'));
        await awaitDocQuiescence(client.doc);

        const serverBytes = getServerState(server, docName)?.ytext.toString() ?? '';
        expect(serverBytes).toContain('Content one, edited.'); // non-vacuous: edit landed
        // The tags must NOT gain/lose indentation vs the pre-edit landed bytes
        // (only the edited body text changes). A normalization write-back reddens.
        expect(serverBytes).toBe(landed.replace('Content one.', 'Content one, edited.'));
      } finally {
        await client.cleanup();
      }
    });
  }
});
