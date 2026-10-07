const [, , configPath, serverKey] = process.argv;
if (!configPath || !serverKey || !process.send || !process.connected) {
  process.stderr.write('config-race-worker: requires IPC and <configPath> <serverKey>\n');
  process.exit(64);
}

const report = process.send.bind(process);
report('started');

try {
  const [{ EDITOR_TARGETS }, { writeEditorMcpConfig }] = await Promise.all([
    import('../../../src/commands/editors.ts'),
    import('../../../src/commands/init.ts'),
  ]);
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
  process.stderr.write(
    `config-race-worker(${process.pid}): unexpected throw: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
}
process.exit();
