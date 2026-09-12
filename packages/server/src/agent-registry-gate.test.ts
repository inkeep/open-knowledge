import type { HostSnapshot } from '@inkeep/open-knowledge-core';
import { EMPTY_DETECTION_SNAPSHOT, EMPTY_PROBE_SNAPSHOT } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import { observeReadiness, type ReadinessObservationLogger } from './agent-registry-gate.ts';

function captureLog(): {
  log: ReadinessObservationLogger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  return { log: { info, warn }, info, warn };
}

const EMPTY_SNAPSHOT: HostSnapshot = {
  probes: EMPTY_PROBE_SNAPSHOT,
  detection: EMPTY_DETECTION_SNAPSHOT,
};

describe('observeReadiness', () => {
  test('records a verdict with both requirement statuses for a registered agent', async () => {
    const { log, info } = captureLog();

    const assessment = await observeReadiness({
      site: 'acp-thread',
      agentId: 'claude',
      mode: 'acp',
      log,
      snapshot: async () => EMPTY_SNAPSHOT,
    });

    expect(assessment?.verdict).toBeDefined();
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] ?? [];
    expect(message).toBe('[agent-gate] readiness');
    expect(fields).toMatchObject({
      site: 'acp-thread',
      mode: 'acp',
      agent: 'claude',
      registered: true,
    });
    expect(fields.mcp).toBeDefined();
    expect(fields.skill).toBeDefined();
  });

  test('logs an unregistered agent without repeating the id it was given', async () => {
    const { log, info } = captureLog();

    const assessment = await observeReadiness({
      site: 'acp-thread',
      agentId: 'some-agent-the-user-named-themselves',
      mode: 'acp',
      log,
      snapshot: async () => EMPTY_SNAPSHOT,
    });

    expect(assessment?.verdict).toBe('not-registered');
    const [fields] = info.mock.calls[0] ?? [];
    expect(fields.agent).toBeNull();
    expect(fields.registered).toBe(false);
    expect(JSON.stringify(fields)).not.toContain('some-agent-the-user-named-themselves');
  });

  test('answers unprobed rather than absent when no host snapshot is wired', async () => {
    const { log, info } = captureLog();

    await observeReadiness({ site: 'terminal', agentId: 'claude', mode: 'terminal', log });

    const [fields] = info.mock.calls[0] ?? [];
    expect(fields.mcp).toBe('met');
    expect(fields.mcpConfidence).toBe('unverified');
  });

  test('swallows a snapshot that throws and says so instead', async () => {
    const { log, info, warn } = captureLog();

    const assessment = await observeReadiness({
      site: 'deep-link',
      agentId: 'claude',
      mode: 'external',
      log,
      snapshot: async () => {
        throw new Error('probe blew up');
      },
    });

    expect(assessment).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe('[agent-gate] readiness could not be assessed');
  });

  test('does not reject when the logger itself throws', async () => {
    const log = {
      info: () => {
        throw new Error('log sink is gone');
      },
      warn: vi.fn(),
    } as unknown as ReadinessObservationLogger;

    await expect(
      observeReadiness({ site: 'deep-link', agentId: 'claude', mode: 'external', log }),
    ).resolves.toBeNull();
  });
});
