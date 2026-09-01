import {
  buildManagedServerEntry,
  type EditorMcpTarget,
  type McpDeclineReason,
  type McpEntryClassification,
} from '@inkeep/open-knowledge';
import { describe, expect, test } from 'vitest';
import type { McpWiringEditorId } from '../shared/ipc-channels.ts';
import {
  checkAndRepairProjectMcpOnProjectOpen,
  type ProjectMcpReclaimCliSurface,
} from './project-mcp-reclaim.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
const CHAIN_ENTRY = buildManagedServerEntry({ mode: 'published' });
const KNOWN_OLDER_ENTRY = {
  command: '/bin/sh',
  args: ['-l', '-c', '# ok-mcp-v1\nexit 127'],
};

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
  test('skipped on AppImage launches (ephemeral mount path)', async () => {
    const { cli } = buildCli({});
    const r = await checkAndRepairProjectMcpOnProjectOpen({
      projectDir: '/p',
      executablePath: '/tmp/.mount_okXYZ/openknowledge',
      isPackaged: true,
      platform: 'linux',
      env: { APPIMAGE: '/home/u/OK.AppImage' },
      cli,
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('appimage-ephemeral');
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

  for (const [platform, exe] of [
    ['linux', '/opt/OpenKnowledge/openknowledge'],
    ['win32', 'C:\\Users\\u\\AppData\\Local\\Programs\\OpenKnowledge\\OpenKnowledge.exe'],
  ] as const) {
    test(`${platform} packaged install runs the repair cycle to done`, async () => {
      const { cli } = buildCli({
        claude: {
          target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
          classification: { kind: 'absent' },
        },
      });
      const r = await checkAndRepairProjectMcpOnProjectOpen({
        projectDir: '/p',
        executablePath: exe,
        isPackaged: true,
        platform,
        cli,
      });
      expect(r.status).toBe('done');
    });
  }

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

  test('recognized future entry → healthy-current, no downgrade write', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: {
          kind: 'present',
          entry: { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v99\nfuture body'] },
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
    if (r.status === 'done') expect(r.perEditor[0]?.status).toBe('healthy-current');
    expect(writes).toEqual([]);
  });

  test('known older entry → reclaimed (write occurs in place, no rename)', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: {
          kind: 'present',
          entry: KNOWN_OLDER_ENTRY,
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

  test('foreign entry → declined without a write', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: {
          kind: 'present',
          entry: { command: '/usr/bin/foreign', args: ['server.js'] },
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
    if (r.status === 'done') {
      expect(r.perEditor[0]).toMatchObject({ status: 'declined', reason: 'foreign-command' });
    }
    expect(writes).toEqual([]);
  });

  test('write declines (read-then-write race) → declined, not a false reclaimed', async () => {
    const { cli, writes } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: {
          kind: 'present',
          entry: KNOWN_OLDER_ENTRY,
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

  test('known older entry emits mcp-config-migrate before the write', async () => {
    const order: string[] = [];
    const target = fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json');
    const baseCli: ProjectMcpReclaimCliSurface = {
      editorTargets: { claude: target } as Record<McpWiringEditorId, EditorMcpTarget>,
      allEditorIds: ['claude' as McpWiringEditorId],
      classifyExistingProjectMcpConfig: () => ({
        kind: 'present',
        entry: KNOWN_OLDER_ENTRY,
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
    expect(order).toEqual(['migrate-event', 'write']);
    const migrate = events.find((e) => e.event === 'mcp-config-migrate');
    expect(migrate).toMatchObject({
      event: 'mcp-config-migrate',
      scope: 'project',
      surface: 'desktop-project-open',
      editorId: 'claude',
      configPath: '/p/.mcp.json',
      priorCommand: '/bin/sh',
      priorArgs: ['-l', '-c', '# ok-mcp-v1\nexit 127'],
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
    expect(writes).toEqual([]);
    expect(events.some((e) => e.event === 'project-mcp-reclaim-corrupt-backup')).toBe(false);
    expect(events.some((e) => e.event === 'project-mcp-reclaim-reclaimed-from-corrupt')).toBe(
      false,
    );
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
        classification: { kind: 'present', entry: KNOWN_OLDER_ENTRY },
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
    expect(writes).toEqual(['cursor']);
  });

  test('write failure surfaces as failed entry', async () => {
    const { cli } = buildCli({
      claude: {
        target: fakeTarget('claude' as McpWiringEditorId, '/p/.mcp.json'),
        classification: { kind: 'present', entry: KNOWN_OLDER_ENTRY },
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
        classification: { kind: 'present', entry: KNOWN_OLDER_ENTRY },
        writeOutcome: { action: 'failed', error: 'EACCES' },
      },
      cursor: {
        target: fakeTarget('cursor' as McpWiringEditorId, '/p/.cursor/mcp.json'),
        classification: { kind: 'present', entry: KNOWN_OLDER_ENTRY },
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
