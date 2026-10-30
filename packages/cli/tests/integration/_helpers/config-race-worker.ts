import { registerHooks } from 'node:module';
import type { WriterMessage } from './config-race.test-helper.ts';

const [, , configPath, serverKey] = process.argv;
if (!configPath || !serverKey || !process.send || !process.connected) {
  process.stderr.write('config-race-worker: requires IPC and <configPath> <serverKey>\n');
  process.exit(64);
}

const send = process.send.bind(process);
const reportCompletions: Promise<void>[] = [];
const publication: { failure?: Error } = {};
const throwIfReportFailed = () => {
  if (publication.failure) throw publication.failure;
};
const report = (message: WriterMessage) => {
  throwIfReportFailed();
  const { promise, resolve } = Promise.withResolvers<void>();
  send(message, (error) => {
    if (error) publication.failure ??= error;
    resolve();
  });
  reportCompletions.push(promise);
};

try {
  report('started');
  const loadedModules = new Set<string>();
  const observer = registerHooks({
    load(url, context, nextLoad) {
      throwIfReportFailed();
      const loaded = nextLoad(url, context);
      if (!loadedModules.has(url)) {
        loadedModules.add(url);
        report({ type: 'module-loaded', url });
      }
      return loaded;
    },
  });
  const [{ EDITOR_TARGETS }, { writeEditorMcpConfig }] = await Promise.all([
    import('../../../src/commands/editors.ts'),
    import('../../../src/commands/init.ts'),
  ]).finally(() => observer.deregister());
  const target = {
    ...EDITOR_TARGETS.cursor,
    configPath: () => configPath,
    serverName: () => serverKey,
  };
  report('ready');
  const result = writeEditorMcpConfig(target, '', {
    mode: 'published',
    skipAvailabilityCheck: true,
  });
  if (result.action === 'failed') {
    process.stderr.write(
      `config-race-worker(${process.pid}): writeEditorMcpConfig action=failed error=${result.error}\n`,
    );
    process.exitCode = 1;
  } else {
    report('written');
    process.exitCode = 0;
  }
} catch (err) {
  if (!publication.failure || err !== publication.failure) {
    process.stderr.write(
      `config-race-worker(${process.pid}): unexpected throw: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  process.exitCode = 1;
}
await Promise.all(reportCompletions);
if (publication.failure) {
  process.stderr.write(
    `config-race-worker(${process.pid}): IPC report failed: ${publication.failure.message}\n`,
  );
  process.exitCode = 1;
}
process.exit();
