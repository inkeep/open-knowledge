import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  type ConfigFileWatcherUnsubscribe,
  startConfigFileWatcher,
  startMultiPathConfigFileWatcher,
} from './config-file-watcher.ts';

interface Fixture {
  root: string;
  absPath: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ok-config-watcher-'));
  const absPath = join(root, '.ok', 'config.yml');
  mkdirSync(dirname(absPath), { recursive: true });
  return {
    root,
    absPath,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
      }
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

let fx: Fixture;
const cleanups: ConfigFileWatcherUnsubscribe[] = [];

beforeEach(() => {
  fx = makeFixture();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup();
    } catch {
    }
  }
  fx.cleanup();
});

describe('startConfigFileWatcher', () => {
  test('fires onChange when a new file appears at the watched path', async () => {
    const events: string[] = [];
    const cleanup = await startConfigFileWatcher(fx.absPath, (content) => {
      events.push(content);
    });
    cleanups.push(cleanup);

    expect(existsSync(fx.absPath)).toBe(false);
    writeFileSync(fx.absPath, 'theme: dark\n', 'utf-8');

    let attempt = 0;
    const fired = await waitFor(() => {
      if (events.length > 0) return true;
      attempt++;
      writeFileSync(fx.absPath, `theme: dark\nattempt: ${attempt}\n`, 'utf-8');
      return false;
    }, 20_000);
    expect(fired).toBe(true);
    expect(events[0]?.startsWith('theme: dark\n')).toBe(true);
  }, 25_000);

  test('fires onChange when an existing file is modified', async () => {
    writeFileSync(fx.absPath, 'theme: light\n', 'utf-8');

    const events: string[] = [];
    const cleanup = await startConfigFileWatcher(fx.absPath, (content) => {
      events.push(content);
    });
    cleanups.push(cleanup);

    writeFileSync(fx.absPath, 'theme: dark\n', 'utf-8');

    const fired = await waitFor(() => events.length > 0);
    expect(fired).toBe(true);
    expect(events.at(-1)).toBe('theme: dark\n');
  });

  test('does NOT fire onChange on the initial scan (ignoreInitial)', async () => {
    writeFileSync(fx.absPath, 'theme: light\n', 'utf-8');

    const events: string[] = [];
    const cleanup = await startConfigFileWatcher(fx.absPath, (content) => {
      events.push(content);
    });
    cleanups.push(cleanup);

    await wait(750);
    expect(events).toEqual([]);
  });

  test('atomic tmp+rename produces a single change event (awaitWriteFinish)', async () => {
    writeFileSync(fx.absPath, 'theme: light\n', 'utf-8');

    const events: string[] = [];
    const cleanup = await startConfigFileWatcher(fx.absPath, (content) => {
      events.push(content);
    });
    cleanups.push(cleanup);

    const tmpPath = `${fx.absPath}.tmp.test`;
    writeFileSync(tmpPath, 'theme: dark\n', 'utf-8');
    await rename(tmpPath, fx.absPath);

    const fired = await waitFor(() => events.length > 0);
    expect(fired).toBe(true);
    expect(events.at(-1)).toBe('theme: dark\n');

    await wait(200);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(2);
  });

  test('does NOT fire onChange when the file is unlinked', async () => {
    writeFileSync(fx.absPath, 'theme: light\n', 'utf-8');

    const events: string[] = [];
    const cleanup = await startConfigFileWatcher(fx.absPath, (content) => {
      events.push(content);
    });
    cleanups.push(cleanup);

    unlinkSync(fx.absPath);
    await wait(250);
    expect(events).toEqual([]);
  });

  test('cleanup function returned is idempotent', async () => {
    const cleanup = await startConfigFileWatcher(fx.absPath, () => {});
    await cleanup();
    await cleanup();
  });

  test('handler exceptions are caught and do not crash the watcher', async () => {
    let firstFired = false;
    let secondFired = false;
    const cleanup = await startConfigFileWatcher(fx.absPath, (content) => {
      if (!firstFired) {
        firstFired = true;
        throw new Error('boom');
      }
      if (content === 'theme: dark\n') secondFired = true;
    });
    cleanups.push(cleanup);

    writeFileSync(fx.absPath, 'first\n', 'utf-8');
    await waitFor(() => firstFired);

    writeFileSync(fx.absPath, 'theme: dark\n', 'utf-8');
    const fired = await waitFor(() => secondFired);
    expect(fired).toBe(true);
  });
});

describe('startMultiPathConfigFileWatcher', () => {
  function makeMultiFixture(): { root: string; pathA: string; pathB: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'ok-multi-config-watcher-'));
    const pathA = join(root, '.okignore');
    const pathB = join(root, '.gitignore');
    return {
      root,
      pathA,
      pathB,
      cleanup: () => {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
        }
      },
    };
  }

  let multiFx: { root: string; pathA: string; pathB: string; cleanup: () => void };

  beforeEach(() => {
    multiFx = makeMultiFixture();
  });

  afterEach(() => {
    multiFx.cleanup();
  });

  test('rejects empty paths array', async () => {
    let threw = false;
    try {
      await startMultiPathConfigFileWatcher([], () => {});
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('at least one');
    }
    expect(threw).toBe(true);
  });

  test('fires onChange with the path that changed when one of multiple watched files appears', async () => {
    const events: Array<{ path: string; content: string }> = [];
    const cleanup = await startMultiPathConfigFileWatcher(
      [multiFx.pathA, multiFx.pathB],
      (path, content) => {
        events.push({ path, content });
      },
    );
    cleanups.push(cleanup);

    writeFileSync(multiFx.pathA, 'drafts/\n', 'utf-8');

    let attempt = 0;
    const fired = await waitFor(() => {
      if (events.length > 0) return true;
      attempt++;
      writeFileSync(multiFx.pathA, `drafts/\nattempt: ${attempt}\n`, 'utf-8');
      return false;
    }, 20_000);
    expect(fired).toBe(true);
    const matched = events.find((e) => e.path === multiFx.pathA);
    expect(matched).toBeDefined();
    expect(matched?.content.startsWith('drafts/\n')).toBe(true);
    expect(events.some((e) => e.path === multiFx.pathB)).toBe(false);
  }, 25_000);

  test('dispatches independent callbacks per path when both files change', async () => {
    writeFileSync(multiFx.pathA, '*.tmp\n', 'utf-8');
    writeFileSync(multiFx.pathB, 'node_modules/\n', 'utf-8');

    const events: Array<{ path: string; content: string }> = [];
    const cleanup = await startMultiPathConfigFileWatcher(
      [multiFx.pathA, multiFx.pathB],
      (path, content) => {
        events.push({ path, content });
      },
    );
    cleanups.push(cleanup);

    writeFileSync(multiFx.pathA, '*.tmp\n*.log\n', 'utf-8');
    writeFileSync(multiFx.pathB, 'node_modules/\ndist/\n', 'utf-8');

    const fired = await waitFor(
      () =>
        events.some((e) => e.path === multiFx.pathA && e.content.includes('*.log')) &&
        events.some((e) => e.path === multiFx.pathB && e.content.includes('dist/')),
    );
    expect(fired).toBe(true);
  });

  test('does NOT fire on the initial scan (ignoreInitial honored across both paths)', async () => {
    writeFileSync(multiFx.pathA, 'drafts/\n', 'utf-8');
    writeFileSync(multiFx.pathB, 'node_modules/\n', 'utf-8');

    const events: Array<{ path: string; content: string }> = [];
    const cleanup = await startMultiPathConfigFileWatcher(
      [multiFx.pathA, multiFx.pathB],
      (path, content) => {
        events.push({ path, content });
      },
    );
    cleanups.push(cleanup);

    await wait(750);
    expect(events).toEqual([]);
  });

  test('atomic tmp+rename on one path produces a single change event for that path only', async () => {
    writeFileSync(multiFx.pathA, '*.tmp\n', 'utf-8');
    writeFileSync(multiFx.pathB, 'node_modules/\n', 'utf-8');

    const events: Array<{ path: string; content: string }> = [];
    const cleanup = await startMultiPathConfigFileWatcher(
      [multiFx.pathA, multiFx.pathB],
      (path, content) => {
        events.push({ path, content });
      },
    );
    cleanups.push(cleanup);

    const tmpPath = `${multiFx.pathA}.tmp.test`;
    writeFileSync(tmpPath, '*.tmp\n*.log\n', 'utf-8');
    await rename(tmpPath, multiFx.pathA);

    const fired = await waitFor(() => events.length > 0);
    expect(fired).toBe(true);
    const matchedA = events.filter((e) => e.path === multiFx.pathA);
    expect(matchedA.length).toBeGreaterThan(0);
    expect(matchedA.at(-1)?.content).toBe('*.tmp\n*.log\n');
    expect(events.some((e) => e.path === multiFx.pathB)).toBe(false);

    await wait(200);
    expect(matchedA.length).toBeLessThanOrEqual(2);
  });

  test('handler exception on one path does not break event delivery for the other', async () => {
    let threwOnceForA = false;
    const seenOnB: string[] = [];
    const cleanup = await startMultiPathConfigFileWatcher(
      [multiFx.pathA, multiFx.pathB],
      (path, content) => {
        if (path === multiFx.pathA && !threwOnceForA) {
          threwOnceForA = true;
          throw new Error('boom on A');
        }
        if (path === multiFx.pathB) seenOnB.push(content);
      },
    );
    cleanups.push(cleanup);

    writeFileSync(multiFx.pathA, 'first\n', 'utf-8');
    await waitFor(() => threwOnceForA);

    writeFileSync(multiFx.pathB, 'expected\n', 'utf-8');
    const fired = await waitFor(() => seenOnB.includes('expected\n'));
    expect(fired).toBe(true);
  });

  test('cleanup function is idempotent', async () => {
    const cleanup = await startMultiPathConfigFileWatcher([multiFx.pathA, multiFx.pathB], () => {});
    await cleanup();
    await cleanup();
  });

  test('does not fire onChange for sibling files in the same dir that are not in the watched set', async () => {
    const events: Array<{ path: string; content: string }> = [];
    const cleanup = await startMultiPathConfigFileWatcher(
      [multiFx.pathA, multiFx.pathB],
      (path, content) => {
        events.push({ path, content });
      },
    );
    cleanups.push(cleanup);

    const siblingPath = join(multiFx.root, 'unrelated.txt');
    writeFileSync(siblingPath, 'hello\n', 'utf-8');
    await wait(750);
    expect(events).toEqual([]);
  });

  test('does not fire onChange when a watched file is unlinked', async () => {
    writeFileSync(multiFx.pathA, '*.tmp\n', 'utf-8');

    const events: Array<{ path: string; content: string }> = [];
    const cleanup = await startMultiPathConfigFileWatcher(
      [multiFx.pathA, multiFx.pathB],
      (path, content) => {
        events.push({ path, content });
      },
    );
    cleanups.push(cleanup);

    unlinkSync(multiFx.pathA);
    await wait(250);
    expect(events).toEqual([]);
  });
});
