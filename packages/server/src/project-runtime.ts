import type { ServerInstance } from './server-factory.ts';

/**
 * The coarse-grained boundary around one project's stateful resources — the
 * composition surface the capability services (documents, files, search,
 * assets, git/sync, skills, config) build against instead of reaching into
 * constructor internals or hopping through the server's own HTTP API.
 *
 * Grain is deliberately coarse: themed groups of existing resources, no
 * fine-grained sub-interfaces. A seam is promoted to its own injection point
 * only when a second implementation exists to test it against — speculative
 * seam placement is itself a retrofit risk. Every local assumption
 * (filesystem paths, shadow-git, one-project-one-process) stays inside the
 * local constructor; a future runtime implementation varies behind this
 * interface, never by forking consumers.
 *
 * Deliberately NOT here, because they are transport concerns owned by the
 * HTTP composition layer: the HTTP server and port, route mounting, CORS and
 * admission policy, and `lockDir` — the lock file is how transport
 * advertises "a server is dialable at port N", and a runtime has no port.
 * `serverInstanceId` and `durabilityState` stay: their values are runtime
 * state (CRDT restart-recovery reads them); only their advertisement over
 * `/api/server-info` and CC1 belongs to transport.
 */
export interface ProjectRuntime {
  /** Collaborative-document engine and its restart-recovery state. */
  readonly crdt: {
    readonly hocuspocus: ServerInstance['hocuspocus'];
    readonly durabilityState: ServerInstance['durabilityState'];
    readonly cc1Broadcaster: ServerInstance['cc1Broadcaster'];
    readonly serverInstanceId: ServerInstance['serverInstanceId'];
  };
  /** Filesystem anchors and content admission. */
  readonly content: {
    readonly contentDir: string;
    /** Project anchor (`.ok/` home). Equals `contentDir` unless `content.dir` points elsewhere. */
    readonly projectDir: string;
    readonly contentFilter: ServerInstance['contentFilter'];
  };
  /** Derived, rebuildable lookup structures. */
  readonly indexes: {
    readonly basenameIndex: ServerInstance['basenameIndex'];
    readonly resolveEmbed: ServerInstance['resolveEmbed'];
  };
  /** Git-backed sync. Null when dormant or no remote is configured. */
  readonly git: {
    readonly syncEngine: ServerInstance['syncEngine'];
  };
  /** Agent sessions, presence, and ACP integration. */
  readonly agents: {
    readonly sessionManager: ServerInstance['sessionManager'];
    readonly agentFocusBroadcaster: ServerInstance['agentFocusBroadcaster'];
    readonly agentPresenceBroadcaster: ServerInstance['agentPresenceBroadcaster'];
    readonly acpRegistry: ServerInstance['acpRegistry'];
    readonly acpPermissions: ServerInstance['acpPermissions'];
  };
  /** Off-write-path background work. Absent in plugin/ephemeral modes. */
  readonly background: {
    readonly maintenanceCoordinator: ServerInstance['maintenanceCoordinator'];
  };
  /** Fresh-read configuration accessors. Grows as capability extraction promotes them. */
  readonly config: {
    readonly getLinkPreviewsEnabled: ServerInstance['getLinkPreviewsEnabled'];
  };
  readonly ready: ServerInstance['ready'];
  readonly degraded: ServerInstance['degraded'];
  readonly destroy: ServerInstance['destroy'];
}

/**
 * Group an existing `ServerInstance` into the runtime boundary. A pure view:
 * every member IS the instance's member (identity-preserved), so adopting the
 * runtime is a call-site change, never a behavior change. The path anchors
 * come from the composer because `createServer` never exposes them.
 */
export function createProjectRuntime(
  instance: ServerInstance,
  anchors: { contentDir: string; projectDir: string },
): ProjectRuntime {
  return {
    crdt: {
      hocuspocus: instance.hocuspocus,
      durabilityState: instance.durabilityState,
      cc1Broadcaster: instance.cc1Broadcaster,
      serverInstanceId: instance.serverInstanceId,
    },
    content: {
      contentDir: anchors.contentDir,
      projectDir: anchors.projectDir,
      contentFilter: instance.contentFilter,
    },
    indexes: {
      basenameIndex: instance.basenameIndex,
      resolveEmbed: instance.resolveEmbed,
    },
    git: {
      // Live getter, not a value copy: the engine is assigned after async
      // init, and `instance.syncEngine` is itself a getter over that slot.
      get syncEngine() {
        return instance.syncEngine;
      },
    },
    agents: {
      sessionManager: instance.sessionManager,
      agentFocusBroadcaster: instance.agentFocusBroadcaster,
      agentPresenceBroadcaster: instance.agentPresenceBroadcaster,
      acpRegistry: instance.acpRegistry,
      acpPermissions: instance.acpPermissions,
    },
    background: {
      maintenanceCoordinator: instance.maintenanceCoordinator,
    },
    config: {
      getLinkPreviewsEnabled: instance.getLinkPreviewsEnabled,
    },
    ready: instance.ready,
    // Getter for the same liveness reason: the list fills during init.
    get degraded() {
      return instance.degraded;
    },
    destroy: instance.destroy,
  };
}
