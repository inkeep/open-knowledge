/**
 * Wired pre-drain rig: the REAL `setupServerObservers` drain (so a doc's
 * pre-drain controller is registered) PLUS a real `AgentSessionManager` session
 * (so agent undo/write run through their production spines with a real
 * per-session `Y.UndoManager` and real StackItems). This is the rung the H15
 * paired-vector arms assert against — the discriminator's read-only corpus rig
 * covers the classification, this covers the wiring: the flush actually lands in
 * Y.Text before the paired transact, or the checkpoint floor captures the
 * content when it can't.
 *
 * The un-propagated-keystroke window is staged with the shared bridge-race rig's
 * freshness-suppressed echo (a component whose children advance past its stamped
 * `sourceRaw`), so the pending content is genuinely un-propagated at the moment
 * the paired op runs — the same shape `derive-timing-guard.test.ts` proves is a
 * real drain stomp. Imported by sibling `*.test.ts` files; not itself a test.
 */

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

/** A component doc whose child line can advance past its stamped source. */
const WIRED_BASE =
  '## Guide\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n\nTail paragraph.\n';
export const WIRED_STALE_LINE = 'Step one bod';
export const WIRED_PENDING_LINE = 'Step one body.';

function createMockHocuspocus(ydoc: Y.Doc, docName: string) {
  // In production the Hocuspocus `Document` IS the `Y.Doc` (Document extends
  // Y.Doc), and setupServerObservers registers its pre-drain controller keyed by
  // that exact object. Augment the real Y.Doc with the small Document surface the
  // agent spine reads, rather than wrapping it — so `session.dc.document` has the
  // SAME identity the controller was registered under (WeakMap lookup by object).
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
  /** The live per-session record (structural subset used by the tests). */
  readonly session: {
    dc: AgentDirectConnection;
    origin: unknown;
    um: Y.UndoManager;
    docName: string;
    agentId: string;
  };
  /** Canonical markdown of the current XmlFragment. */
  serializeFragment(): string;
  /** Current Y.Text('source') bytes. */
  ytextString(): string;
  /** Real agent write through `applyAgentMarkdownWrite` under the session origin. */
  agentWrite(markdown: string, position: 'append' | 'prepend' | 'replace' | 'patch'): void;
  /** The handler-level pre-drain + write, mirroring an agent-write HTTP handler. */
  agentWriteWithPreDrain(
    markdown: string,
    position: 'append' | 'prepend' | 'replace' | 'patch',
  ): void;
  /** Real agent undo through `applyAgentUndo` (runs the wired pre-drain). */
  agentUndo(scope?: 'last' | 'session' | 'count', count?: number): boolean;
  /**
   * Stage an un-propagated keystroke inside the component (fragment holds
   * `WIRED_PENDING_LINE`, Y.Text still holds `WIRED_STALE_LINE`), with a recent
   * external poke so the echo drain settles freshness-suppressed.
   */
  stageUnpropagatedKeystroke(): void;
  cleanup(): Promise<void>;
}

export interface CreateWiredRigOpts extends CreateRigOpts {
  /** Attach a paired-intake loss reporter (the checkpoint floor). */
  reporter?: BridgeDeriveLossReporter;
}

/** Create a wired pre-drain rig over a real drain + a real agent session. */
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

  // Seed the component base and converge it into Y.Text so the doc rests in the
  // settled state a real doc holds before its first paired op.
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
      // A recent external Y.Text write resets the freshness-quiescence clock, so
      // the echo drain serializes the stale component source and settles without
      // propagating the advanced child — the un-propagated shape.
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
