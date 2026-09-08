import type { HostSnapshot, ProbeWorkItem } from '@inkeep/open-knowledge-core';
import { buildProbeSnapshot, EMPTY_DETECTION_SNAPSHOT } from '@inkeep/open-knowledge-core';
import { describe, expect, it, vi } from 'vitest';
import { observeTerminalLaunch } from './terminal-gate-observation.ts';

const answersAbsent = (_item: ProbeWorkItem) => ({ state: 'absent' }) as const;

async function snapshotOfAnEmptyMachine(): Promise<HostSnapshot> {
  return {
    probes: await buildProbeSnapshot({ env: 'desktop', resolve: answersAbsent }),
    detection: EMPTY_DETECTION_SNAPSHOT,
  };
}

function captureLog(): {
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  return { log: { info: vi.fn(), warn: vi.fn() } };
}

describe('observing a docked-terminal launch', () => {
  it('records the verdict for the agent whose CLI is launching', async () => {
    const { log } = captureLog();

    await observeTerminalLaunch({
      launchCli: 'claude',
      projectRoot: '/tmp/some-project',
      log,
      snapshot: snapshotOfAnEmptyMachine,
    });

    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, message] = log.info.mock.calls[0] ?? [];
    expect(message).toBe('[agent-gate] readiness');
    expect(fields).toMatchObject({
      site: 'terminal',
      mode: 'terminal',
      agent: 'claude',
      registered: true,
    });
  });

  it('reads the project scope at the directory the shell will run in', async () => {
    const { log } = captureLog();
    const snapshot = vi.fn(snapshotOfAnEmptyMachine);

    await observeTerminalLaunch({
      launchCli: 'codex',
      projectRoot: '/tmp/a-different-project',
      log,
      snapshot,
    });

    expect(snapshot).toHaveBeenCalledWith('/tmp/a-different-project');
  });

  it('carries no free-form text into the record', async () => {
    const { log } = captureLog();

    await observeTerminalLaunch({
      launchCli: 'claude',
      projectRoot: '/tmp/some-project',
      log,
      snapshot: snapshotOfAnEmptyMachine,
    });

    const [fields] = log.info.mock.calls[0] ?? [];
    expect(Object.keys(fields as object).sort()).toEqual([
      'agent',
      'mcp',
      'mcpConfidence',
      'mode',
      'registered',
      'site',
      'skill',
      'skillConfidence',
      'verdict',
    ]);
  });

  it('launches an unknown CLI id without naming it in the record', async () => {
    const { log } = captureLog();

    await observeTerminalLaunch({
      launchCli: 'some-cli-we-never-shipped',
      projectRoot: '/tmp/some-project',
      log,
      snapshot: snapshotOfAnEmptyMachine,
    });

    const [fields] = log.info.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ site: 'terminal', agent: null, registered: false });
    expect(JSON.stringify(fields)).not.toContain('some-cli-we-never-shipped');
  });

  it('resolves rather than throws when the machine cannot be read', async () => {
    const { log } = captureLog();

    await expect(
      observeTerminalLaunch({
        launchCli: 'claude',
        projectRoot: '/tmp/some-project',
        log,
        snapshot: async () => {
          throw new Error('probe failed');
        },
      }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });
});
