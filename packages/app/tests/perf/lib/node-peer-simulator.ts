
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';


export interface HumanProfile {
  kind: 'human';
  iki: number;
  burstMs: number;
  pauseMs: number;
}

export interface AgentProfile {
  kind: 'agent';
  writeIntervalMs: number;
  chunkChars: number;
}

export type TypingProfile = HumanProfile | AgentProfile;

export interface NodePeerSimulatorParams {
  port: number;
  docName: string;
  count: number;
  typingProfile: TypingProfile;
  wsHostOverride?: string;
}

export interface NodePeerSimulatorHandle {
  start(): void;
  stop(): Promise<void>;
  getFireCounts(): Record<number, number>;
  readonly count: number;
}


interface PeerState {
  index: number;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  timers: Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>;
  inPause: boolean;
  fireCount: number;
}

function clearAllTimers(peer: PeerState): void {
  for (const t of peer.timers) {
    clearTimeout(t as ReturnType<typeof setTimeout>);
    clearInterval(t as ReturnType<typeof setInterval>);
  }
  peer.timers.clear();
}

function bumpWrite(peer: PeerState, chars: string): void {
  peer.ydoc.transact(() => {
    const ytext = peer.ydoc.getText('source');
    ytext.insert(ytext.length, chars);
  });
  peer.fireCount += 1;
}

function scheduleHumanProfile(peer: PeerState, profile: HumanProfile): void {
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
        await Promise.all(
          peers.map(async (peer) => {
            try {
              peer.provider.destroy();
            } catch {
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
