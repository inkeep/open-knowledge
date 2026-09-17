import { describe, expect, test } from 'vitest';
import type { ResolvedLaunch } from '../launch.ts';
import { CODEX_CONFIG_ENV } from './codex-context.ts';
import { applyLaunchContextWindow, launchContextMechanism } from './launch-context.ts';

const launch = (env: Record<string, string> = {}): ResolvedLaunch =>
  ({ kind: 'npx', args: [], env }) as unknown as ResolvedLaunch;

describe('which harness takes a window at launch', () => {
  test('Codex carries it in its startup config', () => {
    expect(launchContextMechanism('codex-acp')).toBe('codex-config-env');
  });

  test('Claude does not, because its window rides in the model id', () => {
    expect(launchContextMechanism('claude-acp')).toBe('model-variant');
  });

  test('an agent we know nothing about takes none', () => {
    expect(launchContextMechanism('opencode')).toBe('none');
  });
});

describe('applying a chosen window to a launch', () => {
  test('Codex gets the window in CODEX_CONFIG', () => {
    const out = applyLaunchContextWindow(launch({ PATH: '/bin' }), 'codex-acp', 500_000);
    expect(JSON.parse(out.env[CODEX_CONFIG_ENV] as string)).toEqual({
      model_context_window: 500_000,
    });
  });

  test('Claude is returned untouched, since the choice travels as a model id', () => {
    const original = launch({ PATH: '/bin' });
    expect(applyLaunchContextWindow(original, 'claude-acp', 1_000_000)).toBe(original);
  });

  test('an agent with no mechanism is returned untouched', () => {
    const original = launch({ PATH: '/bin' });
    expect(applyLaunchContextWindow(original, 'opencode', 500_000)).toBe(original);
  });

  test('no choice is a no-op for every harness', () => {
    for (const id of ['codex-acp', 'claude-acp', 'opencode']) {
      const original = launch({ PATH: '/bin' });
      expect(applyLaunchContextWindow(original, id, null)).toBe(original);
    }
  });
});
