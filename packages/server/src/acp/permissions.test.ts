import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { AcpPermissionStore } from './permissions.ts';

const log = getLogger('acp-permissions-test');

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

function toolCall(kind: ToolCallUpdate['kind']): ToolCallUpdate {
  return { toolCallId: 'tc1', title: 'test', kind } as ToolCallUpdate;
}

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-perm-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('AcpPermissionStore', () => {
  test('auto-allows read-kind tool calls', () => {
    const store = new AcpPermissionStore(tmp(), log);
    const decision = store.decide('gemini', toolCall('read'), OPTIONS);
    expect(decision.auto?.optionId).toBe('allow');
  });

  test('asks for edit/execute kinds with no grant', () => {
    const store = new AcpPermissionStore(tmp(), log);
    expect(store.decide('gemini', toolCall('edit'), OPTIONS).auto).toBeNull();
    expect(store.decide('gemini', toolCall('execute'), OPTIONS).auto).toBeNull();
  });

  test('never auto-selects when no allow option exists', () => {
    const store = new AcpPermissionStore(tmp(), log);
    const rejectOnly = OPTIONS.filter((o) => o.kind === 'reject_once');
    expect(store.decide('gemini', toolCall('read'), rejectOnly).auto).toBeNull();
  });

  test('allow_always persists per (agent, kind) across store instances', async () => {
    const dir = tmp();
    const store = new AcpPermissionStore(dir, log);
    const always = OPTIONS.find((o) => o.kind === 'allow_always');
    if (always === undefined) throw new Error('fixture');
    await store.recordChoice('gemini', toolCall('edit'), always);

    expect(store.decide('gemini', toolCall('edit'), OPTIONS).auto).not.toBeNull();
    // Different agent / different kind: still asks.
    expect(store.decide('cursor', toolCall('edit'), OPTIONS).auto).toBeNull();
    expect(store.decide('gemini', toolCall('execute'), OPTIONS).auto).toBeNull();

    const rehydrated = new AcpPermissionStore(dir, log);
    expect(rehydrated.hasAllowAlways('gemini', 'edit')).toBe(true);
  });

  test('allow_once selections do not persist', async () => {
    const dir = tmp();
    const store = new AcpPermissionStore(dir, log);
    const once = OPTIONS.find((o) => o.kind === 'allow_once');
    if (once === undefined) throw new Error('fixture');
    await store.recordChoice('gemini', toolCall('edit'), once);
    expect(new AcpPermissionStore(dir, log).hasAllowAlways('gemini', 'edit')).toBe(false);
  });
});
