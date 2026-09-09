import { bootCompositionRig } from './composition-rig.test-helper.ts';

process.once('disconnect', () => process.exit(0));
setTimeout(() => process.exit(2), 20_000).unref();

const contentDir = process.argv[2];
const home = process.argv[3];
if (!contentDir || !home) throw new Error('Upload fixture requires content and home directories.');
const server = await bootCompositionRig(contentDir, { configHomedirOverride: home });
await server.ready;
process.send?.({ port: server.port });
process.on('message', async () => {
  await server.destroy();
  process.exit(0);
});
