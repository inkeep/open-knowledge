import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_ERROR_LOG_MAX_BYTES } from '@inkeep/open-knowledge-core';
import { afterEach, expect, test } from 'vitest';
import {
  type AcpLaunchFailureEntry,
  acpLaunchFailureLogPath,
  recordAcpLaunchFailure,
} from './launch-failure-log.ts';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-launch-failure-log-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<AcpLaunchFailureEntry> = {}): AcpLaunchFailureEntry {
  return {
    at: new Date('2026-09-23T12:00:00.000Z'),
    threadId: 'thread-1',
    agentId: 'codex-acp',
    agentSource: 'registry',
    reason: 'connect',
    detail: 'initialize failed: ACP connection closed',
    machineDetail:
      'npm error code ENOENT\nnpm error path /Users/andrew/.npm/_npx/4142609e2aa780f6/package.json',
    ...overrides,
  };
}

test('appends one redacted entry per failure', async () => {
  const localDir = tmp();
  await recordAcpLaunchFailure(localDir, entry());
  await recordAcpLaunchFailure(
    localDir,
    entry({
      threadId: 'thread-2',
      agentId: 'house-agent',
      agentSource: 'custom',
      reason: 'session-setup',
      detail: 'session setup failed: boom',
      machineDetail: 'Authorization: Bearer fixture-token',
    }),
  );
  const text = readFileSync(acpLaunchFailureLogPath(localDir), 'utf8');
  expect(text).toContain(
    '=== acp launch failure 2026-09-23T12:00:00.000Z thread=thread-1 agent=codex-acp source=registry reason=connect ===\ninitialize failed: ACP connection closed\n--- stderr tail ---\nnpm error code ENOENT\nnpm error path ~/.npm/_npx/4142609e2aa780f6/package.json\n\n',
  );
  expect(text).not.toContain('/Users/andrew');
  expect(text).toContain(
    '=== acp launch failure 2026-09-23T12:00:00.000Z thread=thread-2 agent=house-agent source=custom reason=session-setup ===\nsession setup failed: boom\n--- stderr tail ---\n',
  );
  expect(text).not.toContain('fixture-token');
});

test('omits the stderr section when the failure carried no output', async () => {
  const localDir = tmp();
  await recordAcpLaunchFailure(localDir, entry({ machineDetail: undefined }));
  const text = readFileSync(acpLaunchFailureLogPath(localDir), 'utf8');
  expect(text).toBe(
    '=== acp launch failure 2026-09-23T12:00:00.000Z thread=thread-1 agent=codex-acp source=registry reason=connect ===\ninitialize failed: ACP connection closed\n\n',
  );
});

test('starts over once the log reaches its size bound', async () => {
  const localDir = tmp();
  writeFileSync(acpLaunchFailureLogPath(localDir), 'x'.repeat(SPAWN_ERROR_LOG_MAX_BYTES));
  await recordAcpLaunchFailure(localDir, entry());
  const text = readFileSync(acpLaunchFailureLogPath(localDir), 'utf8');
  expect(text.startsWith('=== acp launch failure')).toBe(true);
  expect(text).not.toContain('xxxx');
});

test('concurrent writes at the bound keep every entry', async () => {
  const localDir = tmp();
  writeFileSync(acpLaunchFailureLogPath(localDir), 'x'.repeat(SPAWN_ERROR_LOG_MAX_BYTES));
  await Promise.all([
    recordAcpLaunchFailure(localDir, entry()),
    recordAcpLaunchFailure(localDir, entry({ threadId: 'thread-2' })),
  ]);
  const text = readFileSync(acpLaunchFailureLogPath(localDir), 'utf8');
  expect(text).not.toContain('xxxx');
  expect(text).toContain('thread=thread-1');
  expect(text).toContain('thread=thread-2');
});
