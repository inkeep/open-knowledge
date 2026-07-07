#!/usr/bin/env bun

/**
 * Worker for the mcp-host-config concurrent-write race regression test.
 *
 * Invokes the production `writeEditorMcpConfig` directly with a
 * `cursor`-shaped target whose `configPath` and `serverName` are overridden
 * to point at the test's fixture file. This exercises the actual
 * locked read-modify-write code path that the race lives in (read the config
 * text, surgically upsert only our entry, atomic-write), without forcing the
 * test to build a fake `EditorMcpTarget` from scratch.
 *
 * Usage (invoked by the test, never directly):
 *   bun run config-race-worker.ts <configPath> <serverKey>
 */

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
