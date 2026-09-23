import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { ThreadChatGrant } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { AcpPermissionStore, readAutoApproveOkTools } from './permissions.ts';

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
    expect(store.decide('cursor', toolCall('edit'), OPTIONS).auto).toBeNull();
    expect(store.decide('gemini', toolCall('execute'), OPTIONS).auto).toBeNull();

    const rehydrated = new AcpPermissionStore(dir, log);
    expect(rehydrated.hasAllowAlways('gemini', 'edit')).toBe(true);
  });

  test('auto-allows calls to the OpenKnowledge MCP server, whatever the harness names them', () => {
    const store = new AcpPermissionStore(tmp(), log);
    const claude = {
      toolCallId: 'tc1',
      title: 'mcp__open-knowledge__write',
      kind: 'edit',
    } as ToolCallUpdate;
    const codex = {
      toolCallId: 'tc2',
      title: 'mcp.open-knowledge.exec',
      kind: 'execute',
      rawInput: { server: 'open-knowledge', tool: 'exec', arguments: { command: 'ls' } },
    } as ToolCallUpdate;
    const pi = { toolCallId: 'tc3', title: 'ok_search', kind: 'search' } as ToolCallUpdate;
    for (const call of [claude, codex, pi]) {
      expect(store.decide('claude', call, OPTIONS).auto?.optionId).toBe('allow');
    }
  });

  test('the five gated OK tools still ask, and the user setting turns the rest off', () => {
    const store = new AcpPermissionStore(tmp(), log);
    for (const tool of ['delete', 'move', 'share_link', 'install', 'import']) {
      const call = {
        toolCallId: 'tc1',
        title: `mcp__open-knowledge__${tool}`,
        kind: 'other',
      } as ToolCallUpdate;
      expect(store.decide('claude', call, OPTIONS).auto).toBeNull();
    }
    const write = {
      toolCallId: 'tc2',
      title: 'mcp__open-knowledge__write',
      kind: 'edit',
    } as ToolCallUpdate;
    expect(store.decide('claude', write, OPTIONS, undefined, false).auto).toBeNull();
    expect(store.decide('claude', write, OPTIONS, undefined, true).auto?.optionId).toBe('allow');
  });

  test('a gated OK tool asks no matter what kind it carries or what the agent was allowed before', async () => {
    const store = new AcpPermissionStore(tmp(), log);
    const always = OPTIONS.find((o) => o.kind === 'allow_always');
    if (always === undefined) throw new Error('fixture');
    const gated = (kind: ToolCallUpdate['kind']): ToolCallUpdate =>
      ({ toolCallId: 'tc1', title: 'mcp__open-knowledge__delete', kind }) as ToolCallUpdate;
    await store.recordChoice('claude', toolCall('other'), always);
    expect(store.decide('claude', toolCall('other'), OPTIONS).auto).not.toBeNull();
    expect(store.decide('claude', gated('other'), OPTIONS).auto).toBeNull();
    expect(store.decide('claude', gated('read'), OPTIONS).auto).toBeNull();
    const granted: ReadonlySet<ThreadChatGrant> = new Set(['read_only_shell']);
    expect(store.decide('claude', gated('execute'), OPTIONS, granted).auto).toBeNull();

    const fresh = new AcpPermissionStore(tmp(), log);
    await fresh.recordChoice('claude', gated('other'), always);
    expect(fresh.hasAllowAlways('claude', 'other')).toBe(false);
    expect(fresh.decide('claude', toolCall('other'), OPTIONS).auto).toBeNull();
  });

  test('a foreign server that borrows an OK tool name still asks', () => {
    const store = new AcpPermissionStore(tmp(), log);
    const foreign = {
      toolCallId: 'tc1',
      title: 'mcp__ok-payments__write',
      kind: 'edit',
    } as ToolCallUpdate;
    const bare = {
      toolCallId: 'tc2',
      title: 'write',
      kind: 'edit',
      rawInput: { tool: 'write' },
    } as ToolCallUpdate;
    expect(store.decide('claude', foreign, OPTIONS).auto).toBeNull();
    expect(store.decide('claude', bare, OPTIONS).auto).toBeNull();
  });

  test('read-only shell commands auto-allow only under the chat grant, and only when read-only', () => {
    const store = new AcpPermissionStore(tmp(), log);
    const shell = (command: string): ToolCallUpdate =>
      ({
        toolCallId: 'tc1',
        title: command,
        kind: 'execute',
        rawInput: { command },
      }) as ToolCallUpdate;
    const granted: ReadonlySet<ThreadChatGrant> = new Set(['read_only_shell']);
    expect(store.decide('claude', shell('ls -la'), OPTIONS).auto).toBeNull();
    expect(store.decide('claude', shell('ls -la'), OPTIONS, granted).auto?.optionId).toBe('allow');
    expect(store.decide('claude', shell('rm -rf scratch'), OPTIONS, granted).auto).toBeNull();
    expect(store.decide('claude', shell('ls > out.txt'), OPTIONS, granted).auto).toBeNull();
  });

  test('readAutoApproveOkTools reads the user config and defaults to on', () => {
    const home = tmp();
    const projectDir = tmp();
    expect(readAutoApproveOkTools(projectDir, home)).toBe(true);
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents:\n  autoApproveOkTools: false\n');
    expect(readAutoApproveOkTools(projectDir, home)).toBe(false);
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents:\n  autoApproveOkTools: true\n');
    expect(readAutoApproveOkTools(projectDir, home)).toBe(true);
    writeFileSync(join(home, '.ok', 'global.yml'), 'telemetry: {}\n');
    expect(readAutoApproveOkTools(projectDir, home)).toBe(true);
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
