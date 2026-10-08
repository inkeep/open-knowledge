import { expect } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';

export async function bootArtifactAdmissionRig(root: string): Promise<BootedServer> {
  const server = await bootCompositionRig(root, { enableTestRoutes: true });
  await server.ready;
  await server.generatedIndexSweepReady;
  return server;
}

export async function settleArtifactContributors(server: BootedServer): Promise<void> {
  const response = await rawRequest(server.port, '/api/test-flush-git', { method: 'POST' });
  expect(response.status, response.body).toBe(200);
}
