#!/usr/bin/env bun


import { EDITOR_TARGETS } from '../../../src/commands/editors.ts';
import { writeEditorMcpConfig } from '../../../src/commands/init.ts';

const [, , configPath, serverKey] = process.argv;
if (!configPath || !serverKey) {
  process.stderr.write('config-race-worker: usage: <configPath> <serverKey>\n');
  process.exit(64); // EX_USAGE
}

const baseTarget = EDITOR_TARGETS.cursor;
const target = {
  ...baseTarget,
  configPath: () => configPath,
  serverName: () => serverKey,
};

try {
  const result = await writeEditorMcpConfig(
    target,
    '',
    { mode: 'published', skipAvailabilityCheck: true },
    undefined,
  );
  if (result.action === 'failed') {
    process.stderr.write(
      `config-race-worker(${process.pid}): writeEditorMcpConfig action=failed error=${result.error}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(
    `config-race-worker(${process.pid}): unexpected throw: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
