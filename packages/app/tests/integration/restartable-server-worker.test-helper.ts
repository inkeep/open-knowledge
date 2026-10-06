import type { RestartWorkerOptions } from './restartable-server.test-helper.ts';

let booting: Promise<import('@inkeep/open-knowledge-server').BootedServer> | undefined;
let stopping: Promise<void> | undefined;
function stop(code: number): Promise<void> {
  stopping ??= (async () => {
    try {
      const server = await booting;
      await server?.destroy();
    } catch (error) {
      code = 1;
      if (process.connected) process.send?.({ status: 'error', message: String(error) });
      else process.stderr.write(`${String(error)}\n`);
    } finally {
      process.exit(code);
    }
  })();
  return stopping;
}

process.once('disconnect', () => {
  void stop(1);
});

const { bootServer, ConfigSchema }: typeof import('@inkeep/open-knowledge-server') = await import(
  process.env.OK_TEST_RESTART_SERVER_MODULE ?? '@inkeep/open-knowledge-server'
);

process.once('message', async (options: RestartWorkerOptions) => {
  try {
    booting = bootServer({
      authorityRegistryPath: options.authorityRegistryPath,
      contentDir: options.contentDir,
      configHomedirOverride: options.configHomedirOverride,
      config: ConfigSchema.parse({}),
      host: '127.0.0.1',
      port: options.port,
      quiet: true,
      debounce: options.debounce,
      maxDebounce: options.maxDebounce,
      gitEnabled: options.gitEnabled,
      commitDebounceMs: options.commitDebounceMs,
      keepaliveGraceMs: options.keepaliveGraceMs,
      enableTestRoutes: true,
      idleShutdownMs: null,
    });
    const server = await booting;
    await server.ready;
    if (!process.connected) {
      await stop(1);
      return;
    }
    process.on('message', async (command) => {
      if (command !== 'shutdown') return;
      await stop(0);
    });
    process.send?.({
      status: 'ready',
      port: server.port,
      pid: process.pid,
      serverInstanceId: server.serverInstance.serverInstanceId,
    });
  } catch (error) {
    if (process.connected) process.send?.({ status: 'error', message: String(error) });
    await stop(1);
  }
});
