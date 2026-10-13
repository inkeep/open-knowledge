import { homedir } from 'node:os';
import { bootServer } from '../boot.ts';
import { ConfigSchema } from '../config/schema.ts';

process.once('disconnect', () => process.exit(0));
setTimeout(() => process.exit(2), 30_000).unref();

const [contentDir, home, homeMode] = process.argv.slice(2);
if (
  contentDir === undefined ||
  home === undefined ||
  (homeMode !== 'isolated' && homeMode !== 'process-home')
) {
  throw new Error(
    'The test-reset home fixture needs a content dir, a home dir and isolated or process-home.',
  );
}
if (homedir() !== home) {
  throw new Error(
    `The test-reset home fixture refuses to start: its HOME is ${homedir()}, not the test home ${home}.`,
  );
}
const server = await bootServer({
  host: '127.0.0.1',
  config: ConfigSchema.parse({}),
  contentDir,
  port: 0,
  quiet: true,
  gitEnabled: false,
  idleShutdownMs: null,
  enableTestRoutes: true,
  acpRegistryFetchImpl: (async () => {
    throw new Error('the test-reset home fixture makes no network requests');
  }) as typeof fetch,
  ...(homeMode === 'isolated' ? { configHomedirOverride: home } : {}),
});
await server.ready;
process.send?.({ port: server.port });
process.on('message', async () => {
  await server.destroy();
  process.exit(0);
});
