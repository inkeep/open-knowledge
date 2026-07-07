/**
 * Node-side HocuspocusProvider peer
 * simulator. Used by the `activity-mount-sweep.ts` scenario to drive
 * realistic CRDT peer load against a local dev server while the local
 * Chromium client (under Playwright) is being measured.
 *
 * Why Node-side and NOT Playwright multi-context:
 *   Multi-context Playwright shares one Chromium browser; same-origin
 *   contexts may collapse into one renderer process. Measuring local
 *   keystroke-to-paint under peer CPU through that setup conflates the
 *   real observer-CPU cost peers impose on the local Y.Doc with parasitic
 *   React-render cost from peer tabs (a lab artifact). Production: each
 *   collaborator is on a different machine. Local user's machine only
 *   sees WebSocket-delivered CRDT bytes, not peer React renders.
 *   This library models that exactly — peer Y.Docs run in Node, only
 *   WebSocket traffic to local user is identical to production.
 *
 * Why a parallel cleanroom library and NOT a physical move from
 * `tests/integration/test-harness.ts:createTestClients`:
 *   The integration test-harness wires `setupObservers` for bridge
 *   correctness (which is what integration tests need). The peer
 *   simulator does NOT need bridge correctness — it just needs to
 *   produce realistic CRDT update shapes (Y.Text inserts) at a tunable
 *   rate. Decoupling avoids: (a) breaking integration tests if we ever
 *   need to evolve simulator semantics; (b) coupling perf-scenario
 *   runtime to integration-test invariants.
 *
 * Library invariants:
 *   1. NO Playwright dependency (importable from Node test runners and
 *      from Playwright-driven scenarios alike).
 *   2. NO dependency on `tests/integration/test-harness.ts` (this is a
 *      parallel extraction; integration tests must continue to pass
 *      unchanged).
 *   3. `stop()` resolves only after every peer's provider has cleanly
 *      destroyed AND every scheduled timer has been cleared.
 *   4. `start()` and `stop()` are idempotent — second calls are no-ops.
 *   5. Typing profiles are pure parameters (no architectural opinion).
 */

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Realistic-human typing schedule (CHI 2018 median 239 ms IKI;
 * 5 s burst / 3 s pause cycle to avoid over-stressing observers vs continuous
 * typing).
 */
export interface HumanProfile {
  kind: 'human';
  /** Inter-keystroke interval in ms during a burst. */
  iki: number;
  /** Length of typing burst in ms before pause begins. */
  burstMs: number;
  /** Length of pause between bursts in ms. */
  pauseMs: number;
}

/**
 * Speculative MCP-agent typing profile (values approximate observed
 * Claude cadence, may refine when real telemetry exists).
 */
export interface AgentProfile {
  kind: 'agent';
  /** Interval between successive writes in ms. */
  writeIntervalMs: number;
  /** Number of chars to insert per write. */
  chunkChars: number;
}

export type TypingProfile = HumanProfile | AgentProfile;

export interface NodePeerSimulatorParams {
  /** Local Hocuspocus port — typically the dev server's port. */
  port: number;
  /** Doc the peers join. All peers share this name (= same Hocuspocus document). */
  docName: string;
  /** Number of peer providers to spawn. */
  count: number;
  /** Typing schedule applied uniformly to every peer. */
  typingProfile: TypingProfile;
  /**
   * Optional URL scheme + host override. Defaults to `ws://localhost:`. Tests
   * targeting a non-default host can set this to e.g. `ws://test-runner:`.
   */
  wsHostOverride?: string;
}

export interface NodePeerSimulatorHandle {
  /** Begin scheduled writes on all peers. Second call is a no-op. */
  start(): void;
  /**
   * Cancel scheduled writes, disconnect every provider, await clean
   * teardown. Resolves only after all timers are cleared and all providers
   * have destroyed. Second call is a no-op (resolves immediately).
   */
  stop(): Promise<void>;
  /**
   * Per-peer write count snapshot. Useful for asserting the simulator is
   * producing traffic and for diagnosing per-peer skew.
   * Stable across calls; final after `stop()` resolves.
   */
  getFireCounts(): Record<number, number>;
  /** Number of peers spawned. */
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Internal peer state
// ---------------------------------------------------------------------------

interface PeerState {
  index: number;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  /** Active timer handles. Cleared on stop(). */
  timers: Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>;
  /** Whether the peer is currently in a `pause` window of the human profile. */
  inPause: boolean;
  /** Number of writes this peer has submitted. */
  fireCount: number;
}

function clearAllTimers(peer: PeerState): void {
  for (const t of peer.timers) {
    // setTimeout / setInterval handles can both be cleared by both APIs in Node.
    clearTimeout(t as ReturnType<typeof setTimeout>);
    clearInterval(t as ReturnType<typeof setInterval>);
  }
  peer.timers.clear();
}

function bumpWrite(peer: PeerState, chars: string): void {
  // Local transaction (origin defaults to provider's connection origin per
  // HocuspocusProvider — but we do not pass an origin here so the txn is
  // local: true on the peer's own Y.Doc, and remote: true once it reaches
  // any other client via the WebSocket). The local measurement client
  // sees these as non-local because they arrive over the wire.
  peer.ydoc.transact(() => {
    const ytext = peer.ydoc.getText('source');
    ytext.insert(ytext.length, chars);
  });
  peer.fireCount += 1;
}

function scheduleHumanProfile(peer: PeerState, profile: HumanProfile): void {
  // One full cycle: burst window of `iki`-spaced inserts, then `pauseMs`
  // of silence, then loop. We model this with two timers per peer:
  // (a) an `iki` interval that fires writes during the burst
  // (b) a `burstMs` timeout that flips the peer into pause mode and
  //     queues the next burst-start `pauseMs` later.
  const startBurst = (): void => {
    if (peer.inPause) return;
    const interval = setInterval(() => {
      if (peer.inPause) return;
      bumpWrite(peer, 'a');
    }, profile.iki);
    peer.timers.add(interval);

    const burstEnd = setTimeout(() => {
      peer.inPause = true;
      clearInterval(interval);
      peer.timers.delete(interval);
      const pauseEnd = setTimeout(() => {
        peer.inPause = false;
        startBurst();
      }, profile.pauseMs);
      peer.timers.add(pauseEnd);
    }, profile.burstMs);
    peer.timers.add(burstEnd);
  };

  startBurst();
}

function scheduleAgentProfile(peer: PeerState, profile: AgentProfile): void {
  const filler = 'a'.repeat(Math.max(1, profile.chunkChars));
  const interval = setInterval(() => {
    bumpWrite(peer, filler);
  }, profile.writeIntervalMs);
  peer.timers.add(interval);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Node-side peer simulator. Spins up `count` HocuspocusProvider
 * instances each with its own Y.Doc, all joined to `docName`. Returns a
 * handle whose `start()` begins the scheduled write traffic and `stop()`
 * cleanly tears everything down.
 *
 * The factory does NOT wait for initial sync. Hocuspocus protocol handles
 * the handshake transparently — writes queued before sync land after the
 * provider receives the server's initial state. Callers that need
 * sync-then-write semantics can wait on `provider.on('synced', ...)` per
 * peer in their own code; for perf simulation the handshake + first writes
 * naturally interleave the way they would in a real fleet.
 */
export function createNodePeerSimulator(params: NodePeerSimulatorParams): NodePeerSimulatorHandle {
  if (params.count < 0) {
    throw new Error('[node-peer-simulator] count must be >= 0');
  }
  const wsHost = params.wsHostOverride ?? 'ws://localhost:';
  const url = `${wsHost}${params.port}/collab`;

  const peers: PeerState[] = [];
  for (let i = 0; i < params.count; i++) {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url,
      name: params.docName,
      document: ydoc,
      // Use a long forceSyncInterval so the perf simulator does not flood
      // the local user's measurement window with synthetic forceSync events.
      // Real production cadence (5s) lives in `provider-pool.ts`; the perf
      // simulator's job is to model the WRITE side, not the keepalive side.
      forceSyncInterval: 60_000,
    });
    peers.push({
      index: i,
      ydoc,
      provider,
      timers: new Set(),
      inPause: false,
      fireCount: 0,
    });
  }

  let started = false;
  let stopping: Promise<void> | null = null;

  const handle: NodePeerSimulatorHandle = {
    count: params.count,
    start(): void {
      if (started || stopping) return;
      started = true;
      for (const peer of peers) {
        if (params.typingProfile.kind === 'human') {
          scheduleHumanProfile(peer, params.typingProfile);
        } else {
          scheduleAgentProfile(peer, params.typingProfile);
        }
      }
    },
    async stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        for (const peer of peers) {
          clearAllTimers(peer);
        }
        // Destroy providers in parallel — disconnect is fire-and-forget at
        // the WebSocket level; the destroy() method handles awareness +
        // listener cleanup synchronously. We `await Promise.all` so any
        // async cleanup inside destroy() (Hocuspocus internals may
        // schedule work via microtasks) settles before stop() resolves.
        await Promise.all(
          peers.map(async (peer) => {
            try {
              peer.provider.destroy();
            } catch {
              // best-effort — already-destroyed throws are safe to ignore
            }
            peer.ydoc.destroy();
          }),
        );
      })();
      return stopping;
    },
    getFireCounts(): Record<number, number> {
      const out: Record<number, number> = {};
      for (const peer of peers) {
        out[peer.index] = peer.fireCount;
      }
      return out;
    },
  };

  return handle;
}
