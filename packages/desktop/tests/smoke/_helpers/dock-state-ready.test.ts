import { describe, expect, test } from 'vitest';
import { type AgentsDockRecord, waitForAgentsDockPublish } from './dock-state-ready';

const SEEDED_BEFORE_RELOAD: AgentsDockRecord = {
  order: ['thread-a', 'thread-b'],
  activeKey: 'thread-a',
};
const SETTLED_EMPTY_ROSTER: AgentsDockRecord = { order: [], activeKey: null };

describe('agents dock republish barrier', () => {
  test('holds while the main-process record still serves the pre-reload agents order', async () => {
    const REPUBLISH_AT_READ = 4;
    let reads = 0;

    await waitForAgentsDockPublish(
      () => {
        reads += 1;
        return Promise.resolve({
          agents:
            reads < REPUBLISH_AT_READ
              ? structuredClone(SEEDED_BEFORE_RELOAD)
              : SETTLED_EMPTY_ROSTER,
        });
      },
      SEEDED_BEFORE_RELOAD,
      { interval: 5, timeout: 1_000 },
    );

    expect(reads).toBe(REPUBLISH_AT_READ);
  });

  test('holds while the record is absent instead of reading absence as a publication', async () => {
    const PUBLISH_AT_READ = 3;
    let reads = 0;

    await waitForAgentsDockPublish(
      () => {
        reads += 1;
        return Promise.resolve(reads < PUBLISH_AT_READ ? {} : { agents: SETTLED_EMPTY_ROSTER });
      },
      undefined,
      { interval: 5, timeout: 1_000 },
    );

    expect(reads).toBe(PUBLISH_AT_READ);
  });

  test('accepts a republish that changes only the active key', async () => {
    const HELD: AgentsDockRecord = { order: ['thread-a'], activeKey: 'thread-a' };
    const REPUBLISH_AT_READ = 2;
    let reads = 0;

    await waitForAgentsDockPublish(
      () => {
        reads += 1;
        return Promise.resolve({
          agents:
            reads < REPUBLISH_AT_READ
              ? structuredClone(HELD)
              : { order: ['thread-a'], activeKey: null },
        });
      },
      HELD,
      { interval: 5, timeout: 1_000 },
    );

    expect(reads).toBe(REPUBLISH_AT_READ);
  });

  test('accepts a republish that reorders the same keys under the same active key', async () => {
    const HELD: AgentsDockRecord = { order: ['thread-a', 'thread-b'], activeKey: 'thread-a' };
    const REORDERED: AgentsDockRecord = { order: ['thread-b', 'thread-a'], activeKey: 'thread-a' };
    const REPUBLISH_AT_READ = 2;
    let reads = 0;

    await waitForAgentsDockPublish(
      () => {
        reads += 1;
        return Promise.resolve({
          agents: reads < REPUBLISH_AT_READ ? structuredClone(HELD) : REORDERED,
        });
      },
      HELD,
      { interval: 5, timeout: 1_000 },
    );

    expect(reads).toBe(REPUBLISH_AT_READ);
  });

  test('accepts a republish that drops a trailing key under the same active key', async () => {
    const HELD: AgentsDockRecord = { order: ['thread-a', 'thread-b'], activeKey: 'thread-a' };
    const SHRUNK: AgentsDockRecord = { order: ['thread-a'], activeKey: 'thread-a' };
    const REPUBLISH_AT_READ = 2;
    let reads = 0;

    await waitForAgentsDockPublish(
      () => {
        reads += 1;
        return Promise.resolve({
          agents: reads < REPUBLISH_AT_READ ? structuredClone(HELD) : SHRUNK,
        });
      },
      HELD,
      { interval: 5, timeout: 1_000 },
    );

    expect(reads).toBe(REPUBLISH_AT_READ);
  });

  test('fails loud naming absence when the record is never published', async () => {
    let reads = 0;

    await expect(
      waitForAgentsDockPublish(
        () => {
          reads += 1;
          return Promise.resolve({});
        },
        undefined,
        { interval: 5, timeout: 200 },
      ),
    ).rejects.toThrow(/no agents dock record published/u);

    expect(reads).toBeGreaterThan(1);
  });

  test('fails loud naming the stale record when the renderer never republishes', async () => {
    let reads = 0;

    await expect(
      waitForAgentsDockPublish(
        () => {
          reads += 1;
          return Promise.resolve({ agents: structuredClone(SEEDED_BEFORE_RELOAD) });
        },
        SEEDED_BEFORE_RELOAD,
        { interval: 5, timeout: 200 },
      ),
    ).rejects.toThrow(/thread-a/u);

    expect(reads).toBeGreaterThan(1);
  });

  test('fails loud naming the bridge when the reader itself returns no dock state', async () => {
    let reads = 0;

    await expect(
      waitForAgentsDockPublish(
        () => {
          reads += 1;
          return Promise.resolve(undefined);
        },
        SEEDED_BEFORE_RELOAD,
        { interval: 5, timeout: 200 },
      ),
    ).rejects.toThrow(/no dock state read from the desktop bridge/u);

    expect(reads).toBeGreaterThan(1);
  });

  test('rejects a negative budget by naming the contract, not an already-elapsed deadline', async () => {
    await expect(
      waitForAgentsDockPublish(() => Promise.resolve({}), undefined, {
        interval: 5,
        timeout: -1,
      }),
    ).rejects.toThrow(/positive timeout budget/u);
  });

  test('rejects a zero budget rather than polling past the caller deadline', async () => {
    const settled = await Promise.race([
      waitForAgentsDockPublish(() => Promise.resolve({}), undefined, {
        interval: 5,
        timeout: 0,
      }).then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('still waiting'), 500);
      }),
    ]);

    expect(settled).toMatch(/positive timeout budget/u);
  });

  test('rejects a NaN budget, which toPass would otherwise read as no deadline', async () => {
    const settled = await Promise.race([
      waitForAgentsDockPublish(() => Promise.resolve({}), undefined, {
        interval: 5,
        timeout: Number.NaN,
      }).then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('still waiting'), 500);
      }),
    ]);

    expect(settled).toMatch(/positive timeout budget/u);
  });

  test('retries through a bounded run of reader rejections and resolves on the publication', async () => {
    const NAVIGATION_ERROR = 'Execution context was destroyed, most likely because of a navigation';
    const PUBLISH_AT_READ = 3;
    let reads = 0;

    await waitForAgentsDockPublish(
      () => {
        reads += 1;
        return reads < PUBLISH_AT_READ
          ? Promise.reject(new Error(NAVIGATION_ERROR))
          : Promise.resolve({ agents: SETTLED_EMPTY_ROSTER });
      },
      SEEDED_BEFORE_RELOAD,
      { interval: 5, timeout: 1_000 },
    );

    expect(reads).toBe(PUBLISH_AT_READ);
  });

  test('surfaces the reader rejection when the bridge read fails for the whole budget', async () => {
    const NAVIGATION_ERROR = 'Execution context was destroyed, most likely because of a navigation';
    let reads = 0;

    await expect(
      waitForAgentsDockPublish(
        () => {
          reads += 1;
          return Promise.reject(new Error(NAVIGATION_ERROR));
        },
        undefined,
        { interval: 5, timeout: 200 },
      ),
    ).rejects.toThrow(/Execution context was destroyed/u);

    expect(reads).toBeGreaterThan(1);
  });
});
