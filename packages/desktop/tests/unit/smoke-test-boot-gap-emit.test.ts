import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BootGapAttachTarget, emitBootGapLines } from '../smoke/_helpers/boot-gap-emit';
import {
  bootLogDirFor,
  formatBootGapLine,
  rememberBootLog,
  rememberLaunchHome,
} from '../smoke/_helpers/launch-readiness';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper';

interface Attachment {
  name: string;
  body: string;
}

const seededHomes: string[] = [];

afterEach(() => {
  for (const home of seededHomes.splice(0)) removeTempDirBestEffort(home);
  vi.restoreAllMocks();
});

function recorder(over: Partial<TestInfo> = {}): {
  info: BootGapAttachTarget;
  attachments: Attachment[];
  lines: string[];
} {
  const attachments: Attachment[] = [];
  const lines: string[] = [];
  const info = {
    status: 'failed',
    retry: 2,
    project: { retries: 2 },
    attach: async (name: string, opts: { body: string }) => {
      attachments.push({ name, body: String(opts.body) });
    },
    ...over,
  } as unknown as BootGapAttachTarget;
  return { info, attachments, lines };
}

function seedHome(narration: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'ok-bootgap-'));
  seededHomes.push(home);
  if (narration.length > 0) {
    const dir = bootLogDirFor(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'desktop.2026-09-03.log'), `${narration.join('\n')}\n`, 'utf8');
  }
  return home;
}

const line = (phase: string, at: string) =>
  JSON.stringify({ time: at, event: `desktop.startup.${phase}`, phase, elapsedMs: 0 });

const gapOf = (attachments: Attachment[], slot: number) =>
  JSON.parse(attachments.find((a) => a.name === `boot-log-gaps-slot${slot}`)?.body ?? '{}');

describe('the fixture emits one boot-gap line per launch it registered', () => {
  it('names a home shared by two launches, so the label is not derived from one app alone', async () => {
    const home = seedHome([line('appReady', '2026-09-04T00:00:01.000Z')]);
    const first = {};
    const second = {};
    rememberLaunchHome(first, home);
    rememberLaunchHome(second, home);
    const { info, attachments, lines } = recorder();

    await emitBootGapLines([first, second], info, (l) => lines.push(l));

    expect(gapOf(attachments, 0).source).toBe('teardown-read-shared-home');
    expect(gapOf(attachments, 1).source).toBe('teardown-read-shared-home');
    expect(lines).toHaveLength(2);
  });

  it('reports the snapshot a give-up kept, and still attaches the log the disk no longer holds', async () => {
    const narration = [
      line('appReady', '2026-09-04T00:00:01.000Z'),
      line('serverLockReady', '2026-09-04T00:00:14.428Z'),
    ];
    const home = seedHome(narration);
    const app = {};
    rememberLaunchHome(app, home);
    rememberBootLog(app, narration);
    rmSync(join(home, '.ok'), { recursive: true, force: true });
    const { info, attachments, lines } = recorder();

    await emitBootGapLines([app], info, (l) => lines.push(l));

    expect(gapOf(attachments, 0).source).toBe('wait-snapshot');
    expect(gapOf(attachments, 0).summary.lineCount).toBe(narration.length);
    expect(attachments.map((a) => a.name)).toContain('boot-log-slot0');
    expect(attachments.find((a) => a.name === 'boot-log-slot0')?.body).toBe(narration.join('\n'));
  });

  it('prefers the fuller on-disk log over an earlier snapshot, in that order', async () => {
    const early = [line('appReady', '2026-09-04T00:00:01.000Z')];
    const whole = [...early, line('serverLockReady', '2026-09-04T00:00:14.428Z')];
    const home = seedHome(whole);
    const app = {};
    rememberLaunchHome(app, home);
    rememberBootLog(app, early);
    const { info, attachments, lines } = recorder();

    await emitBootGapLines([app], info, (l) => lines.push(l));

    expect(gapOf(attachments, 0).source).toBe('teardown-read');
    expect(gapOf(attachments, 0).summary.lineCount).toBe(whole.length);
  });

  it('withholds the log attachment while a retry is still to come, and keeps the gap line', async () => {
    const narration = [line('appReady', '2026-09-04T00:00:01.000Z')];
    const home = seedHome(narration);
    const app = {};
    rememberLaunchHome(app, home);
    const { info, attachments, lines } = recorder({ retry: 0 } as Partial<TestInfo>);

    await emitBootGapLines([app], info, (l) => lines.push(l));

    expect(attachments.map((a) => a.name)).toEqual(['boot-log-gaps-slot0']);
    expect(lines).toHaveLength(1);
  });

  it('skips a registered app that never recorded a launch home', async () => {
    const { info, attachments, lines } = recorder();

    await emitBootGapLines([{}], info, (l) => lines.push(l));

    expect(attachments).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('writes the boot-gap line to the default console sink at the call shape the fixture uses', async () => {
    const app = {};
    rememberLaunchHome(app, seedHome([line('appReady', '2026-09-04T00:00:01.000Z')]));
    const { info, attachments } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await emitBootGapLines([app], info);

    expect(gapOf(attachments, 0).source).toBe('teardown-read');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[boot-gap\] slot=0 source=teardown-read /u);
    expect(log.mock.calls[0][0]).toBe(formatBootGapLine(gapOf(attachments, 0)));
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps attaching later slots when one slot attach rejects, and names the failure on warn', async () => {
    const narration = [line('appReady', '2026-09-04T00:00:01.000Z')];
    const first = {};
    const second = {};
    rememberLaunchHome(first, seedHome(narration));
    rememberLaunchHome(second, seedHome(narration));
    const { info, attachments } = recorder();
    const failsOnFirstSlot = {
      ...info,
      attach: async (name: string, opts: { body: string }) => {
        if (name === 'boot-log-gaps-slot0') throw new Error('output dir vanished');
        await info.attach(name, opts);
      },
    } as unknown as BootGapAttachTarget;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(emitBootGapLines([first, second], failsOnFirstSlot)).resolves.toBeUndefined();

    expect(attachments.map((a) => a.name)).toEqual(['boot-log-gaps-slot1', 'boot-log-slot1']);
    expect(gapOf(attachments, 1).source).toBe('teardown-read');
    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('boot-log-gaps-slot0');
    expect(warn.mock.calls[0][0]).toContain('output dir vanished');
  });

  it('names the raw log, not the summary, when the second attach is the one that rejects', async () => {
    const narration = [line('appReady', '2026-09-04T00:00:01.000Z')];
    const app = {};
    rememberLaunchHome(app, seedHome(narration));
    const { info, attachments } = recorder();
    const failsOnRawLog = {
      ...info,
      attach: async (name: string, opts: { body: string }) => {
        if (name === 'boot-log-slot0') throw new Error('testInfo torn down');
        await info.attach(name, opts);
      },
    } as unknown as BootGapAttachTarget;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(emitBootGapLines([app], failsOnRawLog)).resolves.toBeUndefined();

    expect(attachments.map((a) => a.name)).toEqual(['boot-log-gaps-slot0']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('boot-log-slot0');
    expect(warn.mock.calls[0][0]).not.toContain('boot-log-gaps-slot0');
    expect(warn.mock.calls[0][0]).toContain('testInfo torn down');
  });
});
