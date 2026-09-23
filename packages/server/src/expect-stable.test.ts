import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { expectStable } from './expect-stable.test-helper.ts';

describe('expectStable', () => {
  test('names the value and the window when the value changes mid-window', async () => {
    let reads = 0;
    const read = () => {
      reads += 1;
      return reads === 1 ? 'baseline bytes' : 'clobbered bytes';
    };

    await expect(
      expectStable('notes.md on disk', read, { durationMs: 200, pollMs: 10 }),
    ).rejects.toThrow('notes.md on disk changed during a 200ms stability window');
  });

  test('catches a change that only surfaces several polls into the window', async () => {
    let reads = 0;
    let value = 'baseline bytes';
    const clobberOnRead = 5;
    const read = () => {
      reads += 1;
      if (reads === clobberOnRead) value = 'clobbered bytes';
      return value;
    };

    await expect(
      expectStable('notes.md on disk', read, { durationMs: 1_000, pollMs: 10 }),
    ).rejects.toThrow('notes.md on disk changed during a 1000ms stability window');
    expect(reads).toBe(clobberOnRead);
  });

  test('resolves with the value it read when that value holds for the whole window', async () => {
    const held = await expectStable('notes.md on disk', () => 'baseline bytes', {
      durationMs: 120,
      pollMs: 10,
    });

    expect(held).toBe('baseline bytes');
  });

  test('holds a number read, the shape the fragment call sites take', async () => {
    const held = await expectStable('the default fragment child count', () => 3, {
      durationMs: 120,
      pollMs: 10,
    });

    expect(held).toBe(3);
  });

  test('rejects an object read, which identity cannot hold', async () => {
    const rejected = expectStable(
      'the default fragment',
      // @ts-expect-error an object read is what the primitive constraint and the runtime guard both reject
      () => ({ children: 1 }),
      { durationMs: 120, pollMs: 10 },
    );

    await expect(rejected).rejects.toThrow(
      'the default fragment was read as object, but expectStable holds a value by identity, which equals value equality only for a primitive, so read a string, number, bigint, boolean, null or undefined instead',
    );
  });

  test('a throwing first read names the value held and keeps the original message', async () => {
    const read = () => {
      throw new Error('ENOENT: no such file or directory, open notes.md');
    };

    await expect(
      expectStable('notes.md on disk', read, { durationMs: 200, pollMs: 10 }),
    ).rejects.toThrow(
      'while holding notes.md on disk: ENOENT: no such file or directory, open notes.md',
    );
  });

  test('a read that starts throwing mid-window names the value held', async () => {
    let reads = 0;
    const read = () => {
      reads += 1;
      if (reads > 1) throw new Error('EACCES: permission denied, open notes.md');
      return 'baseline bytes';
    };

    await expect(
      expectStable('notes.md on disk', read, { durationMs: 1_000, pollMs: 10 }),
    ).rejects.toThrow('while holding notes.md on disk: EACCES: permission denied, open notes.md');
  });

  test('names the value held when the read throws something that is not an Error', async () => {
    const read = () => {
      throw 'the watcher handle went away';
    };

    await expect(
      expectStable('notes.md on disk', read, { durationMs: 200, pollMs: 10 }),
    ).rejects.toThrow('while holding notes.md on disk: the watcher handle went away');
  });

  test('keeps the thrown error as the cause, so its own properties stay readable', async () => {
    const missing = join(tmpdir(), 'expect-stable-absent-notes.md');

    await expect(
      expectStable('notes.md on disk', () => readFileSync(missing, 'utf8'), {
        durationMs: 200,
        pollMs: 10,
      }),
    ).rejects.toHaveProperty('cause.code', 'ENOENT');
  });

  test('keeps the frames of the read that threw, not the frames of the wrapper', async () => {
    const missing = join(tmpdir(), 'expect-stable-absent-notes.md');

    await expect(
      expectStable('notes.md on disk', () => readFileSync(missing, 'utf8'), {
        durationMs: 200,
        pollMs: 10,
      }),
    ).rejects.toHaveProperty('stack', expect.stringMatching(/\n\s+at \S*readFileSync\b/));
  });

  test('keeps a cause chain deeper than one link, the way the origin stays reachable', async () => {
    const read = () => {
      throw new Error('the watcher could not re-open notes.md', {
        cause: new Error('EACCES: permission denied, open notes.md'),
      });
    };

    await expect(
      expectStable('notes.md on disk', read, { durationMs: 200, pollMs: 10 }),
    ).rejects.toHaveProperty('cause.cause.message', 'EACCES: permission denied, open notes.md');
  });

  test('rejects a read whose declared type lies, which the constraint cannot reach', async () => {
    const readsAnObjectButSaysString = (() => ({ children: 1 })) as unknown as () => string;

    await expect(
      expectStable('the default fragment', readsAnObjectButSaysString, {
        durationMs: 120,
        pollMs: 10,
      }),
    ).rejects.toThrow(
      'the default fragment was read as object, but expectStable holds a value by identity',
    );
  });
});
