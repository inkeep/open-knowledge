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
  serializeFragment(): string;
  agentWrite(markdown: string, position: AgentWritePosition): void;
  stageKeystroke(mutate: (fragmentMd: string) => string): void;
  discriminateUndo(): PreDrainVerdict;
  undoInputs(): {
    body: string;
    fmPrefixLen: number;
    ytext: Y.Text;
    stackItem: YjsStackItemShape;
    fragmentPmJson: JSONContent;
  };
  discriminateAgentWrite(payload: string, position: AgentWritePosition): PreDrainVerdict;
  cleanup(): Promise<void>;
}

export async function createDiscriminatorRig(baseMd: string): Promise<DiscriminatorRig> {
  const docName = `corpus-${Math.round(performance.now())}-${baseMd.length}`;
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment('default');
  const ytext = ydoc.getText('source');
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
