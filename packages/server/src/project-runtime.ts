import type { ServerInstance } from './server-factory.ts';

export interface ProjectRuntime {
  readonly crdt: {
    readonly hocuspocus: ServerInstance['hocuspocus'];
    readonly durabilityState: ServerInstance['durabilityState'];
    readonly cc1Broadcaster: ServerInstance['cc1Broadcaster'];
    readonly serverInstanceId: ServerInstance['serverInstanceId'];
  };
  readonly content: {
    readonly contentDir: string;
    readonly projectDir: string;
    readonly contentFilter: ServerInstance['contentFilter'];
  };
  readonly indexes: {
    readonly basenameIndex: ServerInstance['basenameIndex'];
    readonly resolveEmbed: ServerInstance['resolveEmbed'];
  };
  readonly git: {
    readonly syncEngine: ServerInstance['syncEngine'];
  };
  readonly agents: {
    readonly sessionManager: ServerInstance['sessionManager'];
    readonly agentFocusBroadcaster: ServerInstance['agentFocusBroadcaster'];
    readonly agentPresenceBroadcaster: ServerInstance['agentPresenceBroadcaster'];
    readonly acpRegistry: ServerInstance['acpRegistry'];
    readonly acpPermissions: ServerInstance['acpPermissions'];
  };
  readonly background: {
    readonly maintenanceCoordinator: ServerInstance['maintenanceCoordinator'];
  };
  readonly config: {
    readonly getLinkPreviewsEnabled: ServerInstance['getLinkPreviewsEnabled'];
  };
  readonly ready: ServerInstance['ready'];
  readonly degraded: ServerInstance['degraded'];
  readonly destroy: ServerInstance['destroy'];
}

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
    get degraded() {
      return instance.degraded;
    },
    destroy: instance.destroy,
  };
}
