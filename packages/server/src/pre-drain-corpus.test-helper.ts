/**
 * Corpus rig for the pre-drain discriminator: stage a same-block / cross-block
 * concurrency scenario through the REAL agent-write and UndoManager paths, then
 * run the read-only discriminator on the staged pre-propagation state.
 *
 * Fidelity: a real `AgentSessionManager` session over a real `Y.Doc` produces a
 * real per-session `Y.UndoManager` and real StackItems; `applyAgentMarkdownWrite`
 * is the production write spine (self-contained paired write — it derives the
 * fragment itself, so no propagation observer is needed for coherence). The
 * un-propagated window (fragment holds content Y.Text lacks) is held open simply
 * by not attaching a propagation observer: the discriminator is read-only and
 * needs only the staged pre-propagation inputs it would see in production right
 * before the paired transact runs. It is imported by sibling `*.test.ts` files;
 * it is not itself a test.
 */

import type { Document } from '@hocuspocus/server';
import {
  type MarkdownManager,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import type { YjsStackItemShape } from './agent-activity.ts';
import {
  type AgentDirectConnection,
  AgentSessionManager,
  applyAgentMarkdownWrite,
} from './agent-sessions.ts';
import { mdManager as productionMdManager } from './md-manager.ts';
import {
  type AgentWritePosition,
  type PreDrainVerdict,
  planPreDrain,
} from './pre-drain-discriminator.ts';

const schema = getSchema(sharedExtensions);
const EMPTY_UPDATE_META = () => ({ mapping: new Map(), isOMark: new Map() });

// A non-paired, non-session origin for the staged WYSIWYG keystroke: not tracked
// by the session UndoManager and not a paired-write origin, so it lands
// fragment-only (a client edit the propagation observer has not yet drained).
const USER_KEYSTROKE_ORIGIN = { context: { origin: 'corpus-user-keystroke' } };

function createMockHocuspocus(ydoc: Y.Doc, docName: string) {
  const doc = {
    name: docName,
    awareness: { setLocalState() {}, setLocalStateField() {} },
    getText: (name: string) => ydoc.getText(name),
    getMap: (name: string) => ydoc.getMap(name),
    getXmlFragment: (name: string) => ydoc.getXmlFragment(name),
    transact: (fn: () => void, origin?: unknown) => ydoc.transact(fn, origin),
    on: ydoc.on.bind(ydoc),
    off: ydoc.off.bind(ydoc),
  } as unknown as Document;
  const dc = {
    document: doc,
    disconnect: async () => {},
    isDisconnected: () => false,
    transact: () => {},
  } as unknown as AgentDirectConnection;
  return {
    openDirectConnection: async (): Promise<AgentDirectConnection> => dc,
  };
}

export interface DiscriminatorRig {
  readonly doc: Y.Doc;
  readonly mdManager: MarkdownManager;
  /** Canonical markdown of the current XmlFragment (body only in the corpus). */
  serializeFragment(): string;
  /** Real agent write through `applyAgentMarkdownWrite` under the session origin. */
  agentWrite(markdown: string, position: AgentWritePosition): void;
  /** Stage a fragment-only WYSIWYG edit by mutating the current fragment md. */
  stageKeystroke(mutate: (fragmentMd: string) => string): void;
  /** Discriminate in front of an agent undo of the top StackItem. */
  discriminateUndo(): PreDrainVerdict;
  /** Raw undo-discrimination inputs, for span-level inspection. */
  undoInputs(): {
    body: string;
    fmPrefixLen: number;
    ytext: Y.Text;
    stackItem: YjsStackItemShape;
    fragmentPmJson: JSONContent;
  };
  /** Discriminate in front of a further agent write. */
  discriminateAgentWrite(payload: string, position: AgentWritePosition): PreDrainVerdict;
  cleanup(): Promise<void>;
}

/** Seed both CRDTs coherently, open a real session, and expose the rig. */
export async function createDiscriminatorRig(baseMd: string): Promise<DiscriminatorRig> {
  const docName = `corpus-${Math.round(performance.now())}-${baseMd.length}`;
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment('default');
  const ytext = ydoc.getText('source');
  // Seed the canonical settled form (trailing newline included), the state a
  // real doc rests in after its last drain — so the agent write's incremental
  // diff matches production instead of re-authoring the final line over a
  // missing trailing newline.
  const seedMd =
    baseMd === '' ? '' : productionMdManager.serialize(productionMdManager.parse(baseMd));
  ydoc.transact(() => ytext.insert(0, seedMd), 'seed');
  ydoc.transact(() => {
    updateYFragment(
      ydoc,
      frag,
      schema.nodeFromJSON(productionMdManager.parse(seedMd)),
      EMPTY_UPDATE_META(),
    );
  }, 'seed');

  const manager = new AgentSessionManager(createMockHocuspocus(ydoc, docName) as never);
  const session = await manager.getSession(docName, 'agent-corpus');
  const doc = session.dc.document;

  const serializeFragment = (): string =>
    productionMdManager.serialize(yXmlFragmentToProseMirrorRootNode(frag, schema).toJSON());

  const bodyState = (): { body: string; fmPrefixLen: number } => {
    const full = ytext.toString();
    const { body } = stripFrontmatter(full);
    return { body, fmPrefixLen: full.length - body.length };
  };
  const fragmentJson = () => yXmlFragmentToProseMirrorRootNode(frag, schema).toJSON();

  const rig: DiscriminatorRig = {
    doc: ydoc,
    mdManager: productionMdManager,
    serializeFragment,
    agentWrite: (markdown, position) => {
      doc.transact(() => {
        applyAgentMarkdownWrite(doc, markdown, position);
      }, session.origin);
    },
    stageKeystroke: (mutate) => {
      const next = mutate(serializeFragment());
      ydoc.transact(() => {
        updateYFragment(
          ydoc,
          frag,
          schema.nodeFromJSON(productionMdManager.parse(next)),
          EMPTY_UPDATE_META(),
        );
      }, USER_KEYSTROKE_ORIGIN);
    },
    discriminateUndo: () => {
      const { body, fmPrefixLen } = bodyState();
      const stack = session.um.undoStack as unknown as YjsStackItemShape[];
      const stackItem = stack[stack.length - 1];
      return planPreDrain({
        pendingDirty: true,
        body,
        fragmentPmJson: fragmentJson(),
        witnessMatched: true,
        fmPrefixLen,
        op: { kind: 'agent-undo', ytext, stackItem },
        mdManager: productionMdManager,
      }).verdict;
    },
    undoInputs: () => {
      const { body, fmPrefixLen } = bodyState();
      const stack = session.um.undoStack as unknown as YjsStackItemShape[];
      return {
        body,
        fmPrefixLen,
        ytext,
        stackItem: stack[stack.length - 1],
        fragmentPmJson: fragmentJson(),
      };
    },
    discriminateAgentWrite: (_payload, position) => {
      const { body, fmPrefixLen } = bodyState();
      return planPreDrain({
        pendingDirty: true,
        body,
        fragmentPmJson: fragmentJson(),
        witnessMatched: true,
        fmPrefixLen,
        op: { kind: 'agent-write', writeKind: position },
        mdManager: productionMdManager,
      }).verdict;
    },
    cleanup: () => manager.closeAll(),
  };
  return rig;
}
