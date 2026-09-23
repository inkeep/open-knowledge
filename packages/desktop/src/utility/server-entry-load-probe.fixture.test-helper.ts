export type LoadProbeFixtureMode = 'import-before-listener' | 'listener-before-import';

const LOAD_PROBE_FIXTURE_MODE_ENV = 'OK_UTILITY_LOAD_PROBE_FIXTURE_MODE';

const mode = process.env[LOAD_PROBE_FIXTURE_MODE_ENV];

if (mode !== 'import-before-listener' && mode !== 'listener-before-import') {
  throw new Error(
    `${LOAD_PROBE_FIXTURE_MODE_ENV} must be import-before-listener or listener-before-import, got ${JSON.stringify(mode)}`,
  );
}

function registerParentPortListener(): void {
  const parentPort = (
    process as NodeJS.Process & {
      parentPort?: { on(event: 'message', handler: (event: { data: unknown }) => void): void };
    }
  ).parentPort;
  if (!parentPort) {
    throw new Error('load-probe fixture requires process.parentPort to be installed by the probe');
  }
  parentPort.on('message', () => {});
}

if (mode === 'import-before-listener') {
  await import('@inkeep/open-knowledge-core/shadow-repo-layout');
  registerParentPortListener();
} else {
  registerParentPortListener();
  await import('@inkeep/open-knowledge-core/shadow-repo-layout');
}
