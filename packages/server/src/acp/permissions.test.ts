import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { ThreadChatGrant } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTestLogger, getLogger } from '../logger.ts';
import { type BrowserCallIdentity, NOT_A_BROWSER_CALL } from './browser-mcp.ts';
import {
  AcpPermissionStore,
  offeredPermissionOptions,
  readAgentBrowserTools,
  readAutoApproveOkTools,
} from './permissions.ts';

const log = getLogger('acp-permissions-test');

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

function toolCall(kind: ToolCallUpdate['kind']): ToolCallUpdate {
  return { toolCallId: 'tc1', title: 'test', kind } as ToolCallUpdate;
}

function browser(tool: string): BrowserCallIdentity {
  return { kind: 'browser', tool };
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
    const decision = store.decide('gemini', toolCall('read'), OPTIONS, NOT_A_BROWSER_CALL);
    expect(decision.auto?.optionId).toBe('allow');
  });

  test('asks for edit/execute kinds with no grant', () => {
    const store = new AcpPermissionStore(tmp(), log);
    expect(store.decide('gemini', toolCall('edit'), OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
    expect(
      store.decide('gemini', toolCall('execute'), OPTIONS, NOT_A_BROWSER_CALL).auto,
    ).toBeNull();
  });

  test('never auto-selects when no allow option exists', () => {
    const store = new AcpPermissionStore(tmp(), log);
    const rejectOnly = OPTIONS.filter((o) => o.kind === 'reject_once');
    expect(
      store.decide('gemini', toolCall('read'), rejectOnly, NOT_A_BROWSER_CALL).auto,
    ).toBeNull();
  });

  test('allow_always persists per (agent, kind) across store instances', async () => {
    const dir = tmp();
    const store = new AcpPermissionStore(dir, log);
    const always = OPTIONS.find((o) => o.kind === 'allow_always');
    if (always === undefined) throw new Error('fixture');
    await store.recordChoice('gemini', toolCall('edit'), always, NOT_A_BROWSER_CALL);

    expect(
      store.decide('gemini', toolCall('edit'), OPTIONS, NOT_A_BROWSER_CALL).auto,
    ).not.toBeNull();
    expect(store.decide('cursor', toolCall('edit'), OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
    expect(
      store.decide('gemini', toolCall('execute'), OPTIONS, NOT_A_BROWSER_CALL).auto,
    ).toBeNull();

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
      expect(store.decide('claude', call, OPTIONS, NOT_A_BROWSER_CALL).auto?.optionId).toBe(
        'allow',
      );
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
      expect(store.decide('claude', call, OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
    }
    const write = {
      toolCallId: 'tc2',
      title: 'mcp__open-knowledge__write',
      kind: 'edit',
    } as ToolCallUpdate;
    expect(
      store.decide('claude', write, OPTIONS, NOT_A_BROWSER_CALL, undefined, false).auto,
    ).toBeNull();
    expect(
      store.decide('claude', write, OPTIONS, NOT_A_BROWSER_CALL, undefined, true).auto?.optionId,
    ).toBe('allow');
  });

  test('a gated OK tool asks no matter what kind it carries or what the agent was allowed before', async () => {
    const store = new AcpPermissionStore(tmp(), log);
    const always = OPTIONS.find((o) => o.kind === 'allow_always');
    if (always === undefined) throw new Error('fixture');
    const gated = (kind: ToolCallUpdate['kind']): ToolCallUpdate =>
      ({ toolCallId: 'tc1', title: 'mcp__open-knowledge__delete', kind }) as ToolCallUpdate;
    await store.recordChoice('claude', toolCall('other'), always, NOT_A_BROWSER_CALL);
    expect(
      store.decide('claude', toolCall('other'), OPTIONS, NOT_A_BROWSER_CALL).auto,
    ).not.toBeNull();
    expect(store.decide('claude', gated('other'), OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
    expect(store.decide('claude', gated('read'), OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
    const granted: ReadonlySet<ThreadChatGrant> = new Set(['read_only_shell']);
    expect(
      store.decide('claude', gated('execute'), OPTIONS, NOT_A_BROWSER_CALL, granted).auto,
    ).toBeNull();

    const fresh = new AcpPermissionStore(tmp(), log);
    await fresh.recordChoice('claude', gated('other'), always, NOT_A_BROWSER_CALL);
    expect(fresh.hasAllowAlways('claude', 'other')).toBe(false);
    expect(fresh.decide('claude', toolCall('other'), OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
  });

  test('a browser action never rides a stored grant, an OK-tool setting, or a read kind', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'acp-permissions.json'),
      JSON.stringify({
        version: 1,
        grants: [
          'execute',
          'other',
          'read',
          'mcp:ok-browser/browser_navigate',
          'mcp:ok-browser/browser_snapshot',
        ].map((toolKind) => ({ agentId: 'claude', toolKind })),
      }),
    );
    const store = new AcpPermissionStore(dir, log);
    expect(store.hasAllowAlways('claude', 'mcp:ok-browser/browser_snapshot')).toBe(true);
    const identities: BrowserCallIdentity[] = [
      browser('browser_run_code_unsafe'),
      browser('browser_navigate'),
      browser('browser_snapshot'),
      browser('browser_take_screenshot'),
      { kind: 'unverified' },
    ];
    for (const identity of identities) {
      for (const kind of ['execute', 'other', 'read'] as const) {
        expect(
          store.decide('claude', toolCall(kind), OPTIONS, identity, undefined, true).auto,
        ).toBeNull();
      }
    }
    expect(
      store.decide('claude', toolCall('other'), OPTIONS, NOT_A_BROWSER_CALL).auto?.optionId,
    ).toBe('allow');
  });

  test('choosing always-allow on a browser action records nothing', async () => {
    const always = OPTIONS.find((o) => o.kind === 'allow_always');
    if (always === undefined) throw new Error('fixture');
    const store = new AcpPermissionStore(tmp(), log);
    for (const identity of [
      browser('browser_snapshot'),
      browser('browser_navigate'),
      browser('browser_run_code_unsafe'),
      { kind: 'unverified' } as const,
    ]) {
      await store.recordChoice('claude', toolCall('execute'), always, identity);
    }
    for (const kind of [
      'execute',
      'other',
      'mcp:ok-browser/browser_snapshot',
      'mcp:ok-browser/browser_navigate',
    ]) {
      expect(store.hasAllowAlways('claude', kind)).toBe(false);
    }
  });

  test('a browser prompt never offers always-allow', () => {
    const kinds = (identity: BrowserCallIdentity, options = OPTIONS) =>
      offeredPermissionOptions(identity, options).map((o) => o.kind);
    expect(kinds({ kind: 'none' })).toEqual(['allow_once', 'allow_always', 'reject_once']);
    for (const identity of [
      browser('browser_snapshot'),
      browser('browser_navigate'),
      browser('browser_run_code_unsafe'),
      { kind: 'unverified' } as const,
    ]) {
      expect(kinds(identity)).toEqual(['allow_once', 'reject_once']);
    }
    const alwaysOnly = OPTIONS.filter((o) => o.kind !== 'allow_once');
    expect(kinds(browser('browser_snapshot'), alwaysOnly)).toEqual(['reject_once']);
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
    expect(store.decide('claude', foreign, OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
    expect(store.decide('claude', bare, OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
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
    expect(store.decide('claude', shell('ls -la'), OPTIONS, NOT_A_BROWSER_CALL).auto).toBeNull();
    expect(
      store.decide('claude', shell('ls -la'), OPTIONS, NOT_A_BROWSER_CALL, granted).auto?.optionId,
    ).toBe('allow');
    expect(
      store.decide('claude', shell('rm -rf scratch'), OPTIONS, NOT_A_BROWSER_CALL, granted).auto,
    ).toBeNull();
    expect(
      store.decide('claude', shell('ls > out.txt'), OPTIONS, NOT_A_BROWSER_CALL, granted).auto,
    ).toBeNull();
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

  test('a user config that cannot be read is logged once, not on every read', () => {
    const home = tmp();
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents: [unclosed\n');
    const configLog = createTestLogger();
    const warn = vi.spyOn(configLog, 'warn');
    expect(readAutoApproveOkTools(tmp(), home, configLog)).toBe(true);
    expect(readAutoApproveOkTools(tmp(), home, configLog)).toBe(true);
    expect(readAgentBrowserTools(tmp(), home, configLog)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('readAgentBrowserTools reads the user config and defaults to off', () => {
    const home = tmp();
    const projectDir = tmp();
    expect(readAgentBrowserTools(projectDir, home)).toBe(false);
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents:\n  browserTools: true\n');
    expect(readAgentBrowserTools(projectDir, home)).toBe(true);
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents:\n  browserTools: false\n');
    expect(readAgentBrowserTools(projectDir, home)).toBe(false);
  });

  test('allow_once selections do not persist', async () => {
    const dir = tmp();
    const store = new AcpPermissionStore(dir, log);
    const once = OPTIONS.find((o) => o.kind === 'allow_once');
    if (once === undefined) throw new Error('fixture');
    await store.recordChoice('gemini', toolCall('edit'), once, NOT_A_BROWSER_CALL);
    expect(new AcpPermissionStore(dir, log).hasAllowAlways('gemini', 'edit')).toBe(false);
  });
});
