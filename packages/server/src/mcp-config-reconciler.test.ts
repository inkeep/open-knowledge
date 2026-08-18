import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, test } from 'vitest';
import { type NativeTomlMcpEditor, reconcileTrackedMcpConfig } from './mcp-config-reconciler.ts';

const v1 = { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v1\nexit 127'] };
const v2 = { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v2\nexit 127'] };
const v99 = { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v99\nexit 127'] };

function config(entry: unknown, theme = 'dark'): string {
  return [
    '{',
    `  // user setting must survive`,
    `  "theme": "${theme}",`,
    '  "mcpServers": {',
    '    "other": { "command": "other", "env": { "TOKEN": "keep" } },',
    `    "open-knowledge": ${JSON.stringify(entry)}`,
    '  }',
    '}',
    '',
  ].join('\n');
}

describe('reconcileTrackedMcpConfig', () => {
  test('selects a recognized newer entry and preserves the local unowned shell', () => {
    const base = config(v1);
    const local = config(v1, 'light');
    const incoming = config(v2);

    const plan = reconcileTrackedMcpConfig({
      target: '.mcp.json',
      layers: { base, head: base, index: local, worktree: local, incoming },
    });

    expect(plan.kind).toBe('resolved');
    if (plan.kind !== 'resolved') return;
    expect(plan.raw).toContain('"theme": "light"');
    expect(plan.raw).toContain('"other": { "command": "other", "env": { "TOKEN": "keep" } }');
    expect(plan.raw).toContain('# ok-mcp-v2');
    expect(plan.raw).not.toContain('# ok-mcp-v1');
  });

  test('never downgrades a recognized future entry', () => {
    const base = config(v1);
    const future = config(v99);
    const plan = reconcileTrackedMcpConfig({
      target: '.cursor/mcp.json',
      layers: { base, head: base, index: future, worktree: future, incoming: config(v2) },
    });

    expect(plan.kind).toBe('resolved');
    if (plan.kind !== 'resolved') return;
    expect(plan.raw).toContain('# ok-mcp-v99');
    expect(plan.winner.revision).toBe(99);
  });

  test('preserves an incoming user field while upgrading the launcher', () => {
    const base = config({ ...v1, env: { MODE: 'base' } });
    const incoming = config({ ...v2, env: { MODE: 'incoming' } });
    const plan = reconcileTrackedMcpConfig({
      target: '.mcp.json',
      layers: { base, head: base, index: base, worktree: base, incoming },
    });

    expect(plan.kind).toBe('resolved');
    if (plan.kind !== 'resolved') return;
    expect(parseJsonc(plan.raw).mcpServers['open-knowledge']).toMatchObject({
      env: { MODE: 'incoming' },
    });
    expect(plan.raw).toContain('# ok-mcp-v2');
  });

  test('preserves a local user field while accepting an incoming launcher upgrade', () => {
    const base = config({ ...v1, env: { MODE: 'base' } });
    const local = config({ ...v1, env: { MODE: 'local' } });
    const incoming = config({ ...v2, env: { MODE: 'base' } });
    const plan = reconcileTrackedMcpConfig({
      target: '.mcp.json',
      layers: { base, head: base, index: local, worktree: local, incoming },
    });

    expect(plan.kind).toBe('resolved');
    if (plan.kind !== 'resolved') return;
    expect(parseJsonc(plan.raw).mcpServers['open-knowledge']).toMatchObject({
      env: { MODE: 'local' },
    });
    expect(plan.raw).toContain('# ok-mcp-v2');
  });

  test('declines when both sides change the same user-owned entry field', () => {
    const base = config({ ...v1, env: { MODE: 'base' } });
    const local = config({ ...v1, env: { MODE: 'local' } });
    const incoming = config({ ...v2, env: { MODE: 'incoming' } });

    expect(
      reconcileTrackedMcpConfig({
        target: '.mcp.json',
        layers: { base, head: base, index: local, worktree: local, incoming },
      }),
    ).toEqual({ kind: 'declined', reason: 'unowned-shell-conflict' });
  });

  test('declines incompatible unrelated edits instead of choosing ours or theirs', () => {
    const base = config(v1, 'base');
    const plan = reconcileTrackedMcpConfig({
      target: '.mcp.json',
      layers: {
        base,
        head: base,
        index: config(v1, 'local'),
        worktree: config(v1, 'local'),
        incoming: config(v2, 'incoming'),
      },
    });

    expect(plan).toEqual({ kind: 'declined', reason: 'unowned-shell-conflict' });
  });

  test('declines staged/unstaged divergence outside the owned entry', () => {
    const base = config(v1, 'base');
    const plan = reconcileTrackedMcpConfig({
      target: '.mcp.json',
      layers: {
        base,
        head: base,
        index: config(v1, 'staged'),
        worktree: config(v2, 'unstaged'),
        incoming: config(v2, 'base'),
      },
    });

    expect(plan).toEqual({ kind: 'declined', reason: 'index-worktree-divergence' });
  });

  test('declines a foreign same-name entry', () => {
    const base = config(v1);
    const foreign = config({ command: 'my-wrapper', args: [] });
    expect(
      reconcileTrackedMcpConfig({
        target: '.mcp.json',
        layers: { base, head: base, index: foreign, worktree: foreign, incoming: config(v2) },
      }),
    ).toEqual({ kind: 'declined', reason: 'foreign-entry' });
  });

  test('declines truthfully when every layer lacks the managed entry', () => {
    const withoutEntry = JSON.stringify({ mcpServers: { other: { command: 'keep-me' } } });
    expect(
      reconcileTrackedMcpConfig({
        target: '.mcp.json',
        layers: {
          base: withoutEntry,
          head: withoutEntry,
          index: withoutEntry,
          worktree: withoutEntry,
          incoming: withoutEntry,
        },
      }),
    ).toEqual({ kind: 'declined', reason: 'no-entry' });
  });

  test('reports a native TOML write failure as unparseable', () => {
    let upsertCalls = 0;
    const editor: NativeTomlMcpEditor = {
      parseToObject: () => ({ mcp_servers: { 'open-knowledge': v1 } }),
      removeEntry: (raw) => ({ text: raw, existed: true }),
      upsertEntry: (raw) => {
        upsertCalls++;
        if (upsertCalls > 5) throw new Error('synthetic native write failure');
        return { text: raw, existed: true };
      },
    };
    const raw = '[mcp_servers.open-knowledge]\ncommand = "/bin/sh"\n';

    expect(
      reconcileTrackedMcpConfig({
        target: '.codex/config.toml',
        layers: { base: raw, head: raw, index: raw, worktree: raw, incoming: raw },
        tomlEditor: editor,
      }),
    ).toEqual({ kind: 'declined', reason: 'unparseable' });
  });

  test('Pi is not a tracked entry target', () => {
    expect(
      reconcileTrackedMcpConfig({
        target: '.pi/mcp.json',
        layers: { base: null, head: null, index: null, worktree: null, incoming: null },
      }),
    ).toEqual({ kind: 'declined', reason: 'unsupported-target' });
  });
});
