/**
 * The assertion is on the settled `Y.Text` because that is the authoritative source persisted to
 * disk and converged to every peer (precedent #38).
 */

import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { mdManager } from './md-manager.ts';

const schema = getSchema(sharedExtensions);

const STEPS = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'Content one.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content two.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

const INDENTED_STEP = /\n[ \t]+<\/?Step\b/;

const CLIENT_ORIGIN = 'observer-a-verbatim-fallback-respell/client';

let rig: BridgeRaceRig;

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.useFakeTimers({ toFake: ['Date'] });
  rig = createBridgeRaceRig({ docName: 'verbatim-fallback-respell' });
});

afterEach(() => {
  rig?.cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function fragmentWithDegradedStep(index: number, raw: string): JSONContent {
  const json = mdManager.parse(STEPS) as JSONContent;
  const container = json.content?.[0];
  const children = container?.content;
  if (!container || !children) throw new Error('fixture parse did not yield a JSX container');
  children[index] = {
    type: 'rawMdxFallback',
    attrs: { reason: 'Unregistered component: Step', originalSpan: null },
    content: [{ type: 'text', text: raw }],
  };
  container.attrs = { ...container.attrs, sourceDirty: true };
  return json;
}

function degradeWhileTyping(json: JSONContent, typeAfter: string, char: string): void {
  const at = rig.ytext.toString().indexOf(typeAfter) + typeAfter.length;
  rig.stimulus('degrade-while-typing', () => {
    rig.doc.transact(() => {
      updateYFragment(rig.doc, rig.xmlFragment, schema.nodeFromJSON(json), {
        mapping: new Map(),
        isOMark: new Map(),
      });
      rig.ytext.insert(at, char);
    }, CLIENT_ORIGIN);
  });
}

test('a degraded nested block does not re-indent the authored source in Y.Text', () => {
  rig.seedSource(STEPS);
  expect(rig.ytext.toString()).toBe(STEPS);

  degradeWhileTyping(
    fragmentWithDegradedStep(1, '<Step>\n\nContent two.\n\n</Step>'),
    'Content one.',
    'Z',
  );
  rig.settle(3);

  const settled = rig.ytext.toString();
  expect(settled).not.toMatch(INDENTED_STEP);
  expect(settled).toContain('<Step>\n\nContent two.\n\n</Step>');
  expect(settled).toContain('Content one.Z');
  expect((settled.match(/<Step>/g) ?? []).length).toBe(2);
  expect((settled.match(/<\/Step>/g) ?? []).length).toBe(2);
});

test('the authored bytes survive a degraded FIRST nested block', () => {
  rig.seedSource(STEPS);

  degradeWhileTyping(
    fragmentWithDegradedStep(0, '<Step>\n\nContent one.\n\n</Step>'),
    'Content two.',
    'Z',
  );
  rig.settle(3);

  const settled = rig.ytext.toString();
  expect(settled).not.toMatch(INDENTED_STEP);
  expect(settled).toContain('Content one.');
  expect(settled).toContain('Content two.Z');
});
