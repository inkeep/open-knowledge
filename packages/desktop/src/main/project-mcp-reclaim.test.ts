import { describe, expect, test } from 'bun:test';
import {
  buildManagedServerEntry,
  type EditorMcpTarget,
  type McpDeclineReason,
  type McpEntryClassification,
} from '@inkeep/open-knowledge';
import type { McpWiringEditorId } from '../shared/ipc-channels.ts';
import {
  checkAndRepairProjectMcpOnProjectOpen,
  type ProjectMcpReclaimCliSurface,
} from './project-mcp-reclaim.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
const CHAIN_ENTRY = buildManagedServerEntry({ mode: 'published' });

function fakeTarget(id: McpWiringEditorId, projectConfigPath?: string): EditorMcpTarget {
  return {
    id,
    label: id,
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => 'open-knowledge',
    configPath: () => `/home/${id}/config.json`,
    buildEntry: () => CHAIN_ENTRY,
    scope: 'global',
    ...(projectConfigPath ? { projectConfigPath: () => projectConfigPath } : {}),
  };
}

function buildCli(
  perEditor: Record<
    string,
    {
      target: EditorMcpTarget;
      classification?: McpEntryClassification;
      readThrows?: Error;
      writeOutcome?: {
        action: 'overwritten' | 'declined' | 'failed';
        reason?: McpDeclineReason;
        error?: string;
      };
    }
  >,
): { cli: ProjectMcpReclaimCliSurface; writes: string[] } {
  const writes: string[] = [];
  const allEditorIds = Object.keys(perEditor) as McpWiringEditorId[];
  const editorTargets: Record<McpWiringEditorId, EditorMcpTarget> = {} as Record<
    McpWiringEditorId,
    EditorMcpTarget
  >;
  for (const id of allEditorIds) {
    editorTargets[id] = perEditor[id]?.target as EditorMcpTarget;
  }
  return {
    cli: {
      editorTargets,
      allEditorIds,
      classifyExistingProjectMcpConfig: (editorId) => {
        const entry = perEditor[editorId];
        if (entry?.readThrows) throw entry.readThrows;
        return entry?.classification ?? { kind: 'absent' };
      },
      writeProjectMcpConfig: ({ editorId }) => {
        writes.push(editorId);
        return perEditor[editorId]?.writeOutcome ?? { action: 'overwritten' };
      },
    },
    writes,
  };
}

describe('checkAndRepairProjectMcpOnProjectOpen', () => {
  test('skipped on non-darwin', async () => {
    const { cli } = buildCli({});
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'linux',
      cli,
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('platform');
  });

  test('skipped when reclaim disabled', async () => {
    const { cli } = buildCli({});
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
      reclaimDisableEnv: '1',
    });
    expect(r.status).toBe('skipped');
  });

  test('editors without projectConfigPath report unsupported', async () => {
    const { cli, writes } = buildCli({
      'claude-desktop': { target: fakeTarget('claude-desktop' as McpWiringEditorId) },
    });
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.perEditor[0]?.status).toBe('unsupported');
    }
    expect(writes).toEqual([]);
  });

  test('absent file → no-token (no write, no create)', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'absent' },
      },
    });
    const events: Array<Record<string, unknown>> = [];
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
      logger: { event: (e) => events.push(e) },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.perEditor[0]?.status).toBe('no-token');
    expect(writes).toEqual([]);
    expect(events.some((e) => e.event === 'project-mcp-reclaim-no-token')).toBe(true);
  });

  test('valid file with no entry → no-token (do not author into unrelated tool file)', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'no-entry' },
      },
    });
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.perEditor[0]?.status).toBe('no-token');
    expect(writes).toEqual([]);
  });

  test('compatible entry → healthy-current, no write', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'present', entry: CHAIN_ENTRY },
      },
    });
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.perEditor[0]?.status).toBe('healthy-current');
    expect(writes).toEqual([]);
  });

  test('incompatible entry → reclaimed (write occurs in place, no rename)', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: {
          kind: 'present',
          entry: { command: 'npx', args: ['-y', '@inkeep/open-knowledge', 'mcp'] },
        },
      },
    });
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.perEditor[0]?.status).toBe('reclaimed');
    expect(writes).toEqual(['claude']);
  });

  test('write declines (read-then-write race) → declined, not a false reclaimed', async () => {
    // The classify pre-pass sees a reclaimable entry, but the lock-time write
    // declines (a concurrent harness truncated the file, or it grew past the
    // size bound). The sweep must NOT report `reclaimed` for a byte-untouched
    // file, and must surface the bounded decline signal instead.
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: {
          kind: 'present',
          entry: { command: 'npx', args: ['-y', '@inkeep/open-knowledge', 'mcp'] },
        },
        writeOutcome: { action: 'declined', reason: 'unparseable' },
      },
    });
    const events: Array<Record<string, unknown>> = [];
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
      logger: { event: (e) => events.push(e) },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const e = r.perEditor.find((p) => p.editor === 'claude');
      expect(e?.status).toBe('declined');
      if (e?.status === 'declined') expect(e.reason).toBe('unparseable');
    }
    // The write was attempted, but no `reclaimed` event was emitted for it.
    expect(writes).toEqual(['claude']);
    expect(events.some((e) => e.event === 'project-mcp-reclaim-reclaimed')).toBe(false);
    const decline = events.find((e) => e.event === 'mcp-config-decline');
    expect(decline).toMatchObject({
      event: 'mcp-config-decline',
      scope: 'project',
      surface: 'desktop-project-open',
      editorId: 'claude',
      reason: 'unparseable',
    });
    expect(decline).not.toHaveProperty('configPath');
  });

  test('incompatible entry emits mcp-config-migrate before the write', async () => {
    // Records the order of (event-emit, write) calls so we can assert the
    // migrate event lands BEFORE the writer is invoked — captures "intent to
    // migrate" even when the write subsequently fails.
    const order: string[] = [];
    const target = fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json');
    const baseCli: ProjectMcpReclaimCliSurface = {
      editorTargets: { claude: target } as Record<McpWiringEditorId, EditorMcpTarget>,
      allEditorIds: ['claude' as McpWiringEditorId],
      classifyExistingProjectMcpConfig: () => ({
        kind: 'present',
        entry: { command: 'npx', args: ['-y', '@inkeep/open-knowledge', 'mcp'] },
      }),
      writeProjectMcpConfig: () => {
        order.push('write');
        return { action: 'overwritten' };
      },
    };
    const events: Array<Record<string, unknown>> = [];
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli: baseCli,
      logger: {
        event: (e) => {
          if (e.event === 'mcp-config-migrate') order.push('migrate-event');
          events.push(e);
        },
      },
    });
    expect(r.status).toBe('done');
    // Migrate event arrives before the writer is invoked.
    expect(order).toEqual(['migrate-event', 'write']);
    // Event shape matches the shared builder's contract.
    const migrate = events.find((e) => e.event === 'mcp-config-migrate');
    expect(migrate).toMatchObject({
      event: 'mcp-config-migrate',
      scope: 'project',
      surface: 'desktop-project-open',
      editorId: 'claude',
      configPath: '/p/.mcp.json',
      priorCommand: 'npx',
      priorArgs: ['-y', '@inkeep/open-knowledge', 'mcp'],
    });
  });

  test('declined (unparseable) file → left untouched, no write, no rename, decline signal', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'decline', reason: 'unparseable' },
      },
    });
    const events: Array<Record<string, unknown>> = [];
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
      logger: { event: (e) => events.push(e) },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const e = r.perEditor[0];
      expect(e?.status).toBe('declined');
      if (e?.status === 'declined') {
        expect(e.reason).toBe('unparseable');
        expect(e.configPath).toBe('/p/.mcp.json');
      }
    }
    // No registration write is dispatched for a config OK couldn't parse.
    expect(writes).toEqual([]);
    // The destructive `.broken` rename + fresh-write path is gone entirely.
    expect(events.some((e) => e.event === 'project-mcp-reclaim-corrupt-backup')).toBe(false);
    expect(events.some((e) => e.event === 'project-mcp-reclaim-reclaimed-from-corrupt')).toBe(
      false,
    );
    // The only trace is the bounded decline signal — no config path or contents.
    const decline = events.find((e) => e.event === 'mcp-config-decline');
    expect(decline).toMatchObject({
      event: 'mcp-config-decline',
      scope: 'project',
      surface: 'desktop-project-open',
      editorId: 'claude',
      reason: 'unparseable',
    });
    expect(decline).not.toHaveProperty('configPath');
  });

  test('a declined editor does not block a sibling reclaim in the same sweep', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'decline', reason: 'unparseable' },
      },
      cursor: {
        target: fakeTarget('cursor' as McpWiringEditorId, '/p/.cursor/mcp.json'),
        classification: { kind: 'present', entry: { command: 'old' } },
        writeOutcome: { action: 'overwritten' },
      },
    });
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.perEditor.find((e) => e.editor === 'claude')?.status).toBe('declined');
      expect(r.perEditor.find((e) => e.editor === 'cursor')?.status).toBe('reclaimed');
    }
    // Only the reclaimable sibling is written; the declined config is untouched.
    expect(writes).toEqual(['cursor']);
  });

  test('write failure surfaces as failed entry', async () => {
    const { cli } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'present', entry: { command: 'old' } },
        writeOutcome: { action: 'failed', error: 'EACCES' },
      },
    });
    const events: Array<Record<string, unknown>> = [];
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
      logger: { event: (e) => events.push(e) },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const e = r.perEditor[0];
      expect(e?.status).toBe('failed');
      if (e?.status === 'failed') expect(e.error).toBe('EACCES');
    }
    expect(events.some((e) => e.event === 'project-mcp-reclaim-write-failed')).toBe(true);
  });

  test('one editor failing does not block others', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'present', entry: { command: 'old' } },
        writeOutcome: { action: 'failed', error: 'EACCES' },
      },
      cursor: {
        target: fakeTarget('cursor' as McpWiringEditorId, '/p/.cursor/mcp.json'),
        classification: { kind: 'present', entry: { command: 'old' } },
        writeOutcome: { action: 'overwritten' },
      },
    });
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      cli,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.perEditor.find((e) => e.editor === 'claude')?.status).toBe('failed');
      expect(r.perEditor.find((e) => e.editor === 'cursor')?.status).toBe('reclaimed');
    }
    expect(writes).toEqual(['claude', 'cursor']);
  });
});
