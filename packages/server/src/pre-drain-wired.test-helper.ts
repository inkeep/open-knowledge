import type { Document } from '@hocuspocus/server';
import type * as Y from 'yjs';
import {
  type AgentDirectConnection,
  AgentSessionManager,
  type AgentWriteLossDetect,
  agentWritePreDrain,
  applyAgentMarkdownWrite,
  applyAgentUndo,
} from './agent-sessions.ts';
import type { BridgeDeriveLossReporter } from './bridge-loss-detector.ts';
import {
  type BridgeRaceRig,
  type CreateRigOpts,
  createBridgeRaceRig,
} from './bridge-race-rig.test-helper.ts';

const WIRED_BASE =
  '## Guide\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n\nTail paragraph.\n';
export const WIRED_STALE_LINE = 'Step one bod';
export const WIRED_PENDING_LINE = 'Step one body.';

function createMockHocuspocus(ydoc: Y.Doc, docName: string) {
  const doc = ydoc as unknown as Document & { name: string; awareness: unknown };
  (doc as { name: string }).name = docName;
  (doc as { awareness: unknown }).awareness = {
    setLocalState() {},
    setLocalStateField() {},
  };
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

export interface WiredPreDrainRig {
  readonly rig: BridgeRaceRig;
  readonly doc: Y.Doc;
  readonly session: {
    dc: AgentDirectConnection;
    origin: unknown;
    um: Y.UndoManager;
    docName: string;
    agentId: string;
  };
  serializeFragment(): string;
  ytextString(): string;
  agentWrite(markdown: string, position: 'append' | 'prepend' | 'replace' | 'patch'): void;
  agentWriteWithPreDrain(
    markdown: string,
    position: 'append' | 'prepend' | 'replace' | 'patch',
  ): void;
  agentUndo(scope?: 'last' | 'session' | 'count', count?: number): boolean;
  stageUnpropagatedKeystroke(): void;
  cleanup(): Promise<void>;
}

export interface CreateWiredRigOpts extends CreateRigOpts {
  reporter?: BridgeDeriveLossReporter;
}

export async function createWiredPreDrainRig(
  opts: CreateWiredRigOpts = {},
): Promise<WiredPreDrainRig> {
  const docName = opts.docName ?? 'wired-pre-drain.md';
  const rig = createBridgeRaceRig({ ...opts, docName });
  const manager = new AgentSessionManager(createMockHocuspocus(rig.doc, docName) as never);
  if (opts.reporter) manager.attachBridgeLossReporter(opts.reporter);
  const session = (await manager.getSession(docName, 'agent-1')) as unknown as {
    dc: AgentDirectConnection;
    origin: unknown;
    um: Y.UndoManager;
    docName: string;
    agentId: string;
  };
  const document = session.dc.document;

  rig.editFragment(WIRED_BASE);
  rig.settle(1);

  const lossDetect: AgentWriteLossDetect | undefined = opts.reporter
    ? { reporter: opts.reporter, writerId: 'agent-1' }
    : undefined;

  return {
    rig,
    doc: rig.doc,
    session,
    serializeFragment: () => rig.serializeFragment(),
    ytextString: () => rig.ytext.toString(),
    agentWrite: (markdown, position) => {
      rig.advancePastFreshness();
      document.transact(() => {
        applyAgentMarkdownWrite(document, markdown, position, undefined, undefined, lossDetect);
      }, session.origin);
    },
    agentWriteWithPreDrain: (markdown, position) => {
      rig.advancePastFreshness();
      agentWritePreDrain(document, markdown, position);
      document.transact(() => {
        applyAgentMarkdownWrite(document, markdown, position, undefined, undefined, lossDetect);
      }, session.origin);
    },
    agentUndo: (scope = 'last', count) => applyAgentUndo(session as never, scope, undefined, count),
    stageUnpropagatedKeystroke: () => {
      rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing note.\n'));
      rig.echoFragmentEdit(rig.ytext.toString(), WIRED_STALE_LINE, WIRED_PENDING_LINE, {
        advanceFreshness: false,
      });
    },
    cleanup: async () => {
      await manager.closeAll();
      rig.cleanup();
    },
  };
}
