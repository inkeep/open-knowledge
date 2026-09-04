import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  attachCapturedStderr,
  captureElectronStderr,
  type ElectronStderrCapture,
  type StderrAttachTarget,
  type StderrCaptureSource,
} from '../smoke/_helpers/electron-stderr';

type AttachOptions = NonNullable<Parameters<TestInfo['attach']>[1]>;

interface RecordedAttachment {
  name: string;
  options: AttachOptions;
}

let outputDir: string;
let attachments: RecordedAttachment[];

const makeTestInfo = (): StderrAttachTarget => ({
  outputPath: (...segments: string[]) => {
    const target = join(outputDir, ...segments);
    mkdirSync(dirname(target), { recursive: true });
    return target;
  },
  attach: async (name, options = {}) => {
    attachments.push({ name, options });
  },
});

const makeApp = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const app: StderrCaptureSource = { process: () => ({ stdout, stderr }) };
  return { app, stdout, stderr };
};

const makeCapture = (payload: string): ElectronStderrCapture => {
  const { app, stderr } = makeApp();
  const capture = captureElectronStderr(app);
  stderr.write(payload);
  return capture;
};

const drainStreams = () => new Promise((resolve) => setImmediate(resolve));

const startFixture = (prefix: string) => {
  outputDir = mkdtempSync(join(tmpdir(), prefix));
  attachments = [];
};

const endFixture = () => {
  rmSync(outputDir, { recursive: true, force: true });
  vi.restoreAllMocks();
};

describe('captureElectronStderr: attachment materializes a file', () => {
  beforeEach(() => startFixture('ok-stderr-attach-'));
  afterEach(endFixture);

  test('attaches a path under the output directory, not a body', async () => {
    const { app, stderr } = makeApp();
    const capture = captureElectronStderr(app);
    stderr.write('show-gate-timeout after 4000ms\n');
    await drainStreams();

    await capture.attachTo(makeTestInfo(), 0);

    expect(attachments).toHaveLength(1);
    const [{ name, options }] = attachments;
    expect(name).toBe('main-process-stderr');
    expect(options.contentType).toBe('text/plain');
    expect(options.body).toBeUndefined();
    expect(typeof options.path).toBe('string');
    expect(options.path as string).toContain(outputDir);

    const written = readFileSync(options.path as string, 'utf8');
    expect(written).toContain('show-gate-timeout after 4000ms');
    expect(written).toContain('[stderr] ');
  });

  test('an empty buffer still produces a file, so a missing file stays a signal', async () => {
    const { app } = makeApp();
    const capture = captureElectronStderr(app);

    await capture.attachTo(makeTestInfo(), 0);

    const written = readFileSync(attachments[0].options.path as string, 'utf8');
    expect(written).toBe('(no stdout/stderr captured)');
  });

  test('stdout and stderr are both captured, each tagged with its stream', async () => {
    const { app, stdout, stderr } = makeApp();
    const capture = captureElectronStderr(app);
    stdout.write('renderer ready\n');
    stderr.write('navigator-load-failed\n');
    await drainStreams();

    await capture.attachTo(makeTestInfo(), 0);

    const written = readFileSync(attachments[0].options.path as string, 'utf8');
    expect(written).toContain('[stdout] renderer ready');
    expect(written).toContain('[stderr] navigator-load-failed');
  });
});

describe('attachCapturedStderr: the registration walk a fixture calls', () => {
  beforeEach(() => startFixture('ok-stderr-walk-'));
  afterEach(endFixture);

  test('two registered apps get distinct files AND distinct attachment names', async () => {
    const first = makeCapture('from the first launch\n');
    const second = makeCapture('from the second launch\n');
    await drainStreams();

    await attachCapturedStderr(makeTestInfo(), [first, second]);

    expect(attachments.map((a) => a.name)).toEqual([
      'main-process-stderr',
      'main-process-stderr-2',
    ]);
    const pathA = attachments[0].options.path as string;
    const pathB = attachments[1].options.path as string;
    expect(basename(pathA)).toBe('main-process-stderr.txt');
    expect(basename(pathB)).toBe('main-process-stderr-2.txt');
    expect(readFileSync(pathA, 'utf8')).toContain('from the first launch');
    expect(readFileSync(pathB, 'utf8')).toContain('from the second launch');
  });

  test('one capture failing does not throw, and the next capture still lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exploding: ElectronStderrCapture = {
      attachTo: async () => {
        throw new Error('output dir vanished');
      },
    };
    const healthy = makeCapture('second launch survived\n');
    await drainStreams();

    await expect(
      attachCapturedStderr(makeTestInfo(), [exploding, healthy]),
    ).resolves.toBeUndefined();

    const survivor = attachments.find((a) => a.name === 'main-process-stderr-2');
    expect(survivor).toBeDefined();
    expect(readFileSync(survivor?.options.path as string, 'utf8')).toContain(
      'second launch survived',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('main-process-stderr.txt');
    expect(warn.mock.calls[0][0]).toContain('output dir vanished');
  });

  test('a real capture whose attach throws still leaves the file on disk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capture = makeCapture('bytes written before the attach threw\n');
    await drainStreams();
    const rejecting: StderrAttachTarget = {
      ...makeTestInfo(),
      attach: async () => {
        throw new Error('testInfo torn down');
      },
    };

    await attachCapturedStderr(rejecting, [capture]);

    const written = readFileSync(join(outputDir, 'main-process-stderr.txt'), 'utf8');
    expect(written).toContain('bytes written before the attach threw');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('no registered apps attaches nothing', async () => {
    await attachCapturedStderr(makeTestInfo(), []);
    expect(attachments).toHaveLength(0);
  });
});
