import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

let tmpRoot: string;
let booted: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-runtime-'));
  booted = await bootCompositionRig(tmpRoot);
  await booted.ready;
}, 60_000);

afterAll(async () => {
  await booted?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('ProjectRuntime view over ServerInstance', () => {
  test('grouped members are identity-preserved, not copies', () => {
    const { runtime, serverInstance } = booted;
    expect(runtime.crdt.hocuspocus).toBe(serverInstance.hocuspocus);
    expect(runtime.crdt.durabilityState).toBe(serverInstance.durabilityState);
    expect(runtime.crdt.cc1Broadcaster).toBe(serverInstance.cc1Broadcaster);
    expect(runtime.crdt.serverInstanceId).toBe(serverInstance.serverInstanceId);
    expect(runtime.content.contentFilter).toBe(serverInstance.contentFilter);
    expect(runtime.indexes.basenameIndex).toBe(serverInstance.basenameIndex);
    expect(runtime.indexes.resolveEmbed).toBe(serverInstance.resolveEmbed);
    expect(runtime.agents.sessionManager).toBe(serverInstance.sessionManager);
    expect(runtime.agents.agentFocusBroadcaster).toBe(serverInstance.agentFocusBroadcaster);
    expect(runtime.agents.agentPresenceBroadcaster).toBe(serverInstance.agentPresenceBroadcaster);
    expect(runtime.agents.acpRegistry).toBe(serverInstance.acpRegistry);
    expect(runtime.agents.acpPermissions).toBe(serverInstance.acpPermissions);
    expect(runtime.background.maintenanceCoordinator).toBe(serverInstance.maintenanceCoordinator);
    expect(runtime.config.getLinkPreviewsEnabled).toBe(serverInstance.getLinkPreviewsEnabled);
    expect(runtime.ready).toBe(serverInstance.ready);
    expect(runtime.destroy).toBe(serverInstance.destroy);
  });

  test('late-assigned members read live through the view', () => {
    const { runtime, serverInstance } = booted;
    expect(runtime.git.syncEngine).toBe(serverInstance.syncEngine);
    expect(runtime.degraded).toBe(serverInstance.degraded);
  });

  test('path anchors come from the composer', () => {
    expect(booted.runtime.content.contentDir).toBe(booted.contentDir);
    expect(booted.runtime.content.projectDir).toBe(booted.contentDir);
  });
});
