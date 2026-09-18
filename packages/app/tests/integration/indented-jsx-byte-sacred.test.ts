import { setTimeout as wait } from 'node:timers/promises';
import { normalizeBridge } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  mdManager,
  type TestServer,
} from './test-harness';

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
    test(`${name}: a source-mode keystroke stays byte-verbatim`, async () => {
      const docName = `e2-${name.replace(/[^a-z0-9]/gi, '-')}-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        const ytext = client.doc.getText('source');
        await awaitDocQuiescence(client.doc);
        const landed = ytext.toString();

        const at = landed.indexOf(anchor) + anchor.length;
        expect(at).toBeGreaterThan(anchor.length);
        client.doc.transact(() => ytext.insert(at, 'X'));
        const expectedAfterTyping = ytext.toString();
        await awaitDocQuiescence(client.doc);

        const serverBytes = getServerState(server, docName)?.ytext.toString() ?? '';
        expect(serverBytes).toBe(expectedAfterTyping);
      } finally {
        await client.cleanup();
      }
    });
  }
});
