import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';

const SOURCE_SENTINEL = 'Typed in source mode, expected in the WYSIWYG.';

function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, {
    advanceFreshness: false,
  });
}

function sourceWrite(rig: BridgeRaceRig, text: string): void {
  rig.externalYtextEdit('source-write', (yt) => yt.insert(yt.length, `\n${text}\n`), {
    advanceFreshness: false,
  });
}

function serializeFragment(xmlFragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
}

describe('a suspended Observer B leaves the WYSIWYG displaying stale content', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('while the defer guard holds, a source-mode edit is in Y.Text but not in the fragment', () => {
    const rig = createBridgeRaceRig({ docName: 'stale-wysiwyg-defer.md' });
    try {
      stageUnpropagatedKeystroke(rig);

      sourceWrite(rig, SOURCE_SENTINEL);

      expect(rig.ytext.toString()).toContain(SOURCE_SENTINEL);
      expect(rig.serializeFragment()).not.toContain(SOURCE_SENTINEL);
      expect(rig.serializeFragment()).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('control: with the defer guard OFF the same source edit reaches the fragment immediately', () => {
    const rig = createBridgeRaceRig({
      docName: 'stale-wysiwyg-guard-off.md',
      setupOverrides: { deferGuardEnabled: false },
    });
    try {
      stageUnpropagatedKeystroke(rig);

      sourceWrite(rig, SOURCE_SENTINEL);

      expect(rig.ytext.toString()).toContain(SOURCE_SENTINEL);
      expect(rig.serializeFragment()).toContain(SOURCE_SENTINEL);
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('a fresh observer closure DOES repair a diverged fragment — so residency, not attach, is the defect', () => {
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    const staleMd = '# Doc\n\nThe body before the source-mode edit.\n';
    const freshMd = `# Doc\n\nThe body before the source-mode edit.\n\n${SOURCE_SENTINEL}\n`;
    doc.transact(() => {
      const pmNode = schema.nodeFromJSON(mdManager.parse(staleMd));
      updateYFragment(doc, xmlFragment, pmNode, { mapping: new Map(), isOMark: new Map() });
      ytext.insert(0, freshMd);
    }, 'stale-stage');

    expect(ytext.toString()).toContain(SOURCE_SENTINEL);
    expect(serializeFragment(xmlFragment)).not.toContain(SOURCE_SENTINEL);

    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });
    try {
      expect(serializeFragment(xmlFragment)).not.toContain(SOURCE_SENTINEL);

      doc.transact(() => {
        const el = new Y.XmlElement('paragraph');
        xmlFragment.push([el]);
        xmlFragment.delete(xmlFragment.length - 1, 1);
      }, 'settle-probe');

      expect(ytext.toString()).toContain(SOURCE_SENTINEL);
      expect(serializeFragment(xmlFragment)).toContain(SOURCE_SENTINEL);
    } finally {
      cleanup();
    }
  });
});
