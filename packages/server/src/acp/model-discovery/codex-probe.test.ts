import { describe, expect, test } from 'vitest';
import { codexProbeCommand, parseCodexCatalog, probeCodexCatalog } from './codex-probe.ts';

const real = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.6-sol',
      visibility: 'list',
      context_window: 272_000,
      max_context_window: 872_000,
      effective_context_window_percent: 95,
    },
    {
      slug: 'gpt-reserve',
      visibility: 'hide',
      context_window: 272_000,
      max_context_window: 872_000,
      effective_context_window_percent: 95,
    },
  ],
});

describe('reading the Codex catalog', () => {
  test('the shape the installed CLI emits is understood', () => {
    expect(parseCodexCatalog(real)).toEqual([
      {
        slug: 'gpt-5.6-sol',
        visibility: 'list',
        contextWindow: 272_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      },
      {
        slug: 'gpt-reserve',
        visibility: 'hide',
        contextWindow: 272_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      },
    ]);
  });

  test('a bare array is accepted as well as a models wrapper', () => {
    expect(parseCodexCatalog('[{"slug":"x"}]')).toEqual([
      {
        slug: 'x',
        visibility: null,
        contextWindow: null,
        maxContextWindow: null,
        effectivePercent: null,
      },
    ]);
  });

  test('a row with no slug is dropped rather than rendered nameless', () => {
    expect(parseCodexCatalog('{"models":[{"context_window":1},{"slug":""}]}')).toEqual([]);
  });

  test('missing numbers stay null instead of becoming zero', () => {
    const [row] = parseCodexCatalog('{"models":[{"slug":"x","context_window":"lots"}]}');
    expect(row?.contextWindow).toBeNull();
  });

  test('output that is not JSON yields no models rather than throwing', () => {
    for (const raw of ['', 'not json', 'null', '{}', '{"models":"nope"}']) {
      expect(parseCodexCatalog(raw)).toEqual([]);
    }
  });
});

describe('resolving the binary the launch path would use', () => {
  test('a missing binary reads as not-found, not as a failure', async () => {
    const probe = await probeCodexCatalog('definitely-not-a-real-binary-xyz', { PATH: '' });
    expect(probe.outcome).toBe('not-found');
  });

  test('a non-zero exit is a failure, so the login-shell retry does not fire for it', async () => {
    const probe = await probeCodexCatalog(process.execPath, process.env);
    expect(probe.outcome).toBe('failed');
  });

  test('a windows .cmd shim runs through the shell wrap, not execed directly', () => {
    const composed = codexProbeCommand('codex.cmd', { PATH: '' }, 'win32');
    expect(composed.wrap).toBe(true);
    expect(composed.cmd.toLowerCase()).toContain('cmd');
    expect(composed.args.join(' ')).toContain('debug');
  });

  test('elsewhere the binary is invoked directly with the catalog subcommand', () => {
    const composed = codexProbeCommand('codex', { PATH: '/usr/bin' }, 'darwin');
    expect(composed.wrap).toBe(false);
    expect(composed.cmd).toBe('codex');
    expect(composed.args).toEqual(['debug', 'models']);
  });
});
