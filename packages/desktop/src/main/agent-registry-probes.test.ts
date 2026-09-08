import { checkProbeCoverage, type ProbeWorkItem } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import {
  collectDesktopHostSnapshot,
  detectAgentsForRegistry,
  withoutProjectScope,
} from './agent-registry-probes.ts';
import type { EditorPresenceProbes } from './integrations-settings.ts';

const NOTHING_ON_THIS_MACHINE: EditorPresenceProbes = { cliOnPath: {}, schemeHandler: {} };

const answersEverything = (_item: ProbeWorkItem) => ({ state: 'absent' }) as const;

describe('detection', () => {
  it('reports the agents the presence signals prove, in registry order', async () => {
    const snapshot = await detectAgentsForRegistry(async () => ({
      cliOnPath: { codex: true, claude: true },
      schemeHandler: {},
    }));
    expect(snapshot).toEqual({ detected: ['claude', 'codex'], probed: true });
  });

  it('separates found-nothing from could-not-look', async () => {
    const found = await detectAgentsForRegistry(async () => NOTHING_ON_THIS_MACHINE);
    expect(found).toEqual({ detected: [], probed: true });

    const failed = await detectAgentsForRegistry(async () => {
      throw new Error('login shell timed out');
    });
    expect(failed).toEqual({ detected: [], probed: false });
  });

  it('claims nothing for an id that is not an agent OK ships an integration for', async () => {
    const snapshot = await detectAgentsForRegistry(async () => ({
      cliOnPath: { 'some-other-tool': true },
      schemeHandler: {},
    }));
    expect(snapshot.detected).toEqual([]);
  });

  it('reports an agent as absent when its signals say nothing, whatever OK has written', async () => {
    const snapshot = await detectAgentsForRegistry(async () => NOTHING_ON_THIS_MACHINE);
    expect(snapshot.detected).not.toContain('claude');
  });
});

describe('the host snapshot', () => {
  it('answers satisfiers through the resolver it was given', async () => {
    const { probes } = await collectDesktopHostSnapshot({
      resolve: answersEverything,
      probeEditorPresence: async () => NOTHING_ON_THIS_MACHINE,
    });
    expect(checkProbeCoverage(Object.keys(probes.satisfiers))).toEqual({
      missing: [],
      unclaimed: [],
    });
    expect(probes.satisfiers['claude/mcp/user/config-entry']).toEqual({ state: 'absent' });
    expect(probes.env).toBe('desktop');
  });

  it('carries detection alongside the probe answers', async () => {
    const { detection } = await collectDesktopHostSnapshot({
      resolve: answersEverything,
      probeEditorPresence: async () => ({ cliOnPath: { cursor: true }, schemeHandler: {} }),
    });
    expect(detection).toEqual({ detected: ['cursor'], probed: true });
  });

  it('survives a resolver that throws without fabricating an answer', async () => {
    const { probes } = await collectDesktopHostSnapshot({
      resolve: () => {
        throw new Error('EACCES');
      },
      probeEditorPresence: async () => NOTHING_ON_THIS_MACHINE,
    });
    expect(probes.satisfiers['claude/mcp/user/config-entry']).toEqual({ state: 'unprobed' });
  });
});

describe('with no project open', () => {
  it('leaves project-scope rows unprobed instead of reading a stray directory', async () => {
    const { probes } = await collectDesktopHostSnapshot({
      resolve: withoutProjectScope(answersEverything),
      probeEditorPresence: async () => NOTHING_ON_THIS_MACHINE,
    });
    expect(probes.satisfiers['claude/mcp/project/config-entry']).toEqual({ state: 'unprobed' });
  });

  it('still answers the user-global rows, which need no project', async () => {
    const { probes } = await collectDesktopHostSnapshot({
      resolve: withoutProjectScope(answersEverything),
      probeEditorPresence: async () => NOTHING_ON_THIS_MACHINE,
    });
    expect(probes.satisfiers['claude/mcp/user/config-entry']).toEqual({ state: 'absent' });
  });
});
