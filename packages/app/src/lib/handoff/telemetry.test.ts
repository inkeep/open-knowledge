import { describe, expect, test } from 'bun:test';
import { type HandoffStatsLine, recordHandoff } from './telemetry.ts';

const sampleLine: HandoffStatsLine = {
  target: 'claude-cowork',
  host: 'electron',
  outcome: 'ok',
  ts: '2026-04-22T01:55:00.000Z',
};

describe('recordHandoff (renderer-side telemetry)', () => {
  test('Electron host: forwards line verbatim to okDesktop.shell.recordHandoff', async () => {
    const calls: HandoffStatsLine[] = [];
    await recordHandoff(sampleLine, {
      okDesktop: {
        shell: {
          recordHandoff: async (line) => {
            calls.push(line);
          },
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(sampleLine);
  });

  test('Web host (no okDesktop dep, no global): no-op without warning', async () => {
    const warnings: string[] = [];
    await expect(
      recordHandoff(sampleLine, {
        warn: (m) => {
          warnings.push(m);
        },
      }),
    ).resolves.toBeUndefined();
    // Web host is the expected fall-through — no warn noise allowed (every
    // web dispatch would otherwise spam the console).
    expect(warnings).toHaveLength(0);
  });

  test('IPC reject (HOME unwritable / disconnected) → warn, no throw', async () => {
    const warnings: string[] = [];
    await expect(
      recordHandoff(sampleLine, {
        warn: (m) => {
          warnings.push(m);
        },
        okDesktop: {
          shell: {
            recordHandoff: async () => {
              throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            },
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EACCES');
    expect(warnings[0]).toContain('telemetry skipped');
  });

  test('non-Error rejection coerces to String() in the warn message', async () => {
    const warnings: string[] = [];
    await recordHandoff(sampleLine, {
      warn: (m) => {
        warnings.push(m);
      },
      okDesktop: {
        shell: {
          recordHandoff: async () => {
            // Intentionally throws a non-Error to exercise the String(err) branch.
            throw 'string-rejection';
          },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('string-rejection');
  });

  test('schema accepts error outcome with optional reason field', async () => {
    const calls: HandoffStatsLine[] = [];
    const errorLine: HandoffStatsLine = {
      target: 'cursor',
      host: 'electron',
      outcome: 'error',
      ts: '2026-04-22T01:55:00.000Z',
      reason: 'not-installed',
    };
    await recordHandoff(errorLine, {
      okDesktop: {
        shell: {
          recordHandoff: async (line) => {
            calls.push(line);
          },
        },
      },
    });
    expect(calls[0]).toEqual(errorLine);
    expect(calls[0]?.reason).toBe('not-installed');
  });

  test('schema accepts a selection-scoped line with the optional scope field', async () => {
    const calls: HandoffStatsLine[] = [];
    const selectionLine: HandoffStatsLine = {
      target: 'claude-code',
      host: 'electron',
      outcome: 'ok',
      ts: '2026-05-21T01:55:00.000Z',
      scope: 'selection',
    };
    await recordHandoff(selectionLine, {
      okDesktop: {
        shell: {
          recordHandoff: async (line) => {
            calls.push(line);
          },
        },
      },
    });
    expect(calls[0]).toEqual(selectionLine);
    expect(calls[0]?.scope).toBe('selection');
  });

  test('Three sequential calls (matching SPEC §13.1 acceptance) all forward independently', async () => {
    const calls: HandoffStatsLine[] = [];
    const deps = {
      okDesktop: {
        shell: {
          recordHandoff: async (line: HandoffStatsLine) => {
            calls.push(line);
          },
        },
      },
    };
    await recordHandoff({ ...sampleLine, ts: '2026-04-22T00:00:01.000Z' }, deps);
    await recordHandoff({ ...sampleLine, ts: '2026-04-22T00:00:02.000Z' }, deps);
    await recordHandoff({ ...sampleLine, ts: '2026-04-22T00:00:03.000Z' }, deps);
    expect(calls.map((c) => c.ts)).toEqual([
      '2026-04-22T00:00:01.000Z',
      '2026-04-22T00:00:02.000Z',
      '2026-04-22T00:00:03.000Z',
    ]);
  });
});
