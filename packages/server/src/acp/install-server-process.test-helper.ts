import { inspect } from 'node:util';
import { bootCompositionRig } from '../composition-rig.test-helper.ts';
import type { RegistryAgent } from './registry.ts';

process.once('disconnect', () => process.exit(0));
setTimeout(() => process.exit(2), 120_000).unref();

const [contentDir, agentJson] = process.argv.slice(2);
if (contentDir === undefined || agentJson === undefined) {
  throw new Error('The install server process requires a content directory and an agent.');
}
const agent = JSON.parse(agentJson) as RegistryAgent;

const server = await bootCompositionRig(contentDir, {
  acpRegistryFetchImpl: (async () =>
    new Response(JSON.stringify({ agents: [agent] }))) as typeof fetch,
});
await server.ready;

process.once('SIGTERM', () => {
  void server.destroy('external-signal').then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`${inspect(err)}\n`, () => process.exit(1));
    },
  );
});

const manager = server.acpThreadManager;
if (manager === null) throw new Error('The booted server has no ACP thread manager.');
await manager.createThread({ agent: { source: 'registry', id: agent.id } });
