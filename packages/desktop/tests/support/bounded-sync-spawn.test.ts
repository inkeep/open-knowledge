import type { SpawnSyncReturns } from 'node:child_process';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  BoundedSpawnError,
  BoundedSpawnTimeoutError,
  spawnSyncBounded,
} from './bounded-sync-spawn.test-helper.ts';
import {
  WEDGE_BLOCK_MS,
  WEDGE_BUDGET_MS,
  WEDGE_MARKER,
  WEDGE_SCRIPT,
} from './spawn-bound-wedge.test-helper.ts';

type AssertedSpawnFields = Pick<SpawnSyncReturns<string>, 'stdout' | 'status' | 'signal'>;

const NEVER_RAN: AssertedSpawnFields = { stdout: '', status: 0, signal: null };

describe('spawnSyncBounded against a SIGTERM-trapping script', () => {
  let result: AssertedSpawnFields = NEVER_RAN;
  let thrown: unknown;
  let elapsedMs: number;

  beforeAll(() => {
    const startedAt = Date.now();
    try {
      result = spawnSyncBounded('bash', [WEDGE_SCRIPT], { timeoutMs: WEDGE_BUDGET_MS });
    } catch (error) {
      thrown = error;
      if (error instanceof BoundedSpawnTimeoutError) result = error.result;
    }
    elapsedMs = Date.now() - startedAt;
  }, WEDGE_BLOCK_MS * 3);

  test('the wedge reaches its TERM trap and then blocks past the budget', () => {
    expect(
      result.stdout,
      `the wedge never reported reaching its trap, so the bound assertions below would be reading a script that failed at startup rather than one the bound had to preempt, and each would fail for a reason that points away from the fixture: a bash that cannot find its script exits 127 in a millisecond, before any bound could act`,
    ).toContain(WEDGE_MARKER);
    expect(
      elapsedMs,
      `the wedge returned before its ${WEDGE_BUDGET_MS}ms budget even elapsed, so nothing was ever preempted and this suite proves nothing about the bound. The fixture must really sit in a foreground /bin/sleep ${WEDGE_BLOCK_MS / 1000}; note it calls /bin/sleep by absolute path so that a 'sleep' earlier on PATH cannot satisfy it and return at once`,
    ).toBeGreaterThanOrEqual(WEDGE_BUDGET_MS);
  });

  test('the primitive kills the run rather than letting it complete its own TERM cleanup', () => {
    expect(
      result.status,
      `a spawn bound must terminate the spawn within its budget regardless of the child's signal disposition, so the run must die of a signal and carry no exit status of its own. This run was given ${WEDGE_BUDGET_MS}ms; the script traps SIGTERM and sits in a foreground /bin/sleep ${WEDGE_BLOCK_MS / 1000}, and bash defers a trapped signal until the foreground command it is running returns. spawnSync sends exactly one killSignal to the direct child pid with no escalation and no process-group kill, so a timeout with no untrappable killSignal expresses a request, not a bound: the script gets control back, runs its TERM handler and exits on its own terms, and a numeric status here is that, the same observable a wholly unbounded run produces. vitest cannot catch it either, because testTimeout runs on the same worker thread spawnSync has blocked. This takes the contract at the primitive itself, which is the form every importer gets, and it reads a signal disposition rather than a clock, so no amount of host load can flip it`,
    ).toBeNull();
  });

  test('the bound arrives as the one signal a script cannot trap', () => {
    expect(
      result.signal,
      `the killSignal the primitive pins must be untrappable, and SIGKILL is the only one that is. This asserts the literal rather than re-reading UNTRAPPABLE_KILL_SIGNAL from the module under test: a pin that imports its own expectation follows any mutation of it and can never fail. Measured on this fixture, a trappable SIGTERM took 4022ms against a 600ms budget where SIGKILL took 602ms`,
    ).toBe('SIGKILL');
  });

  test('the primitive raises a blown budget rather than returning it as an ordinary result', () => {
    expect(
      thrown,
      `a blown budget must be impossible for a caller to read as an ordinary process outcome. The exit status cannot carry it: a run killed by the bound and a run killed by anything else both arrive as status null, which silently satisfies every assertion that only requires a non-zero exit. Returning the ETIMEDOUT beside the status is not enough either, because a caller has to remember to read it, and a caller that forgets reports whatever its own assertion says about a null status, naming neither the budget nor the command that overran`,
    ).toBeInstanceOf(BoundedSpawnTimeoutError);
    expect(
      (thrown as BoundedSpawnTimeoutError).timeoutMs,
      'the raised error must name the budget that was blown, because that is the number a reader needs to tell a wedged run from a slow one',
    ).toBe(WEDGE_BUDGET_MS);
  });

  test('the raised budget error carries what the run had emitted when the bound fired', () => {
    expect(
      (thrown as BoundedSpawnTimeoutError).message,
      `a reader triaging a wedged run needs the point the script reached, and spawnSync has already captured it up to the kill. vitest renders an error's message and stack and nothing else, so output parked on an own property of the error reaches no failure log and the reader re-runs the script by hand to learn what the CI run already knew. This asserts the message rather than the result field for exactly that reason`,
    ).toContain(WEDGE_MARKER);
  });
});

describe('the spawnSyncBounded reserved options', () => {
  test('a caller cannot reach the bound through a spread, whatever the key order', () => {
    const hostile = {
      killSignal: 'SIGTERM' as const,
      timeout: 60_000,
      encoding: 'latin1' as const,
      shell: true,
    };
    let thrown: unknown;
    try {
      spawnSyncBounded('bash', [WEDGE_SCRIPT], { ...hostile, timeoutMs: WEDGE_BUDGET_MS });
    } catch (error) {
      thrown = error;
    }

    expect(
      thrown,
      `a caller supplied killSignal SIGTERM, a 60s timeout and shell true through a spread. TypeScript excess-property checking does not fire on a spread of a typed value, so the type alone never rejected this; before the reserved keys were stripped explicitly the only thing stopping them was that the return literal happened to write them after the spread, which a reorder or an intervening variable would have silently undone. The wedge traps SIGTERM, so if the caller killSignal had won this call would have run the fixture's full ${WEDGE_BLOCK_MS}ms and returned normally instead of raising, and if the caller 60s timeout had displaced the ${WEDGE_BUDGET_MS}ms budget passed as timeoutMs, no timeout would have fired before the wedge ended on its own, so nothing would have been raised either`,
    ).toBeInstanceOf(BoundedSpawnTimeoutError);
    expect(
      (thrown as BoundedSpawnTimeoutError).result.signal,
      'the bound must still have arrived as the untrappable signal the primitive pins, not the one the caller asked for',
    ).toBe('SIGKILL');
  });
});

describe('the spawnSyncBounded budget precondition', () => {
  test('refuses a zero budget rather than spawning unbounded', () => {
    expect(
      () => spawnSyncBounded('bash', [WEDGE_SCRIPT], { timeoutMs: 0 }),
      `node normalizes a timeout of 0 to no timeout at all, so without this refusal the call does not fail, it spawns the SIGTERM-trapping wedge with no bound and parks this worker thread inside the syscall for the fixture's whole ${WEDGE_BLOCK_MS}ms. Measured both ways: a spawnSync given timeout 0 against this shape ran 4048ms and reported status 0, exactly as an omitted timeout does, and deleting this guard makes this very assertion sit for 5037ms before failing instead of failing at once. The budget has to be refused at the boundary, because no downstream reading can tell an unbounded run from a generous one`,
    ).toThrow(/positive finite budget/);
  });

  test('refuses a non-finite budget with its own diagnosis rather than deferring to node', () => {
    expect(
      () => spawnSyncBounded('bash', [WEDGE_SCRIPT], { timeoutMs: Number.NaN }),
      `the non-finite half of the precondition fails differently from the zero half, and the difference is the point. Node does reject a NaN timeout, but as a bare 'The value of "timeout" is out of range' thrown from inside spawnSync, naming neither the caller nor the budget it was handed. Dropping the isFinite half is therefore not a silent unbounded spawn like the zero case, it is a diagnosis regression, and this pin is what keeps the refusal at the boundary that knows what timeoutMs means`,
    ).toThrow(/positive finite budget/);
  });
});

describe('the spawnSyncBounded non-timeout failure surface', () => {
  const OVERFLOWING_SCRIPT = 'printf "%02000d" 0';

  test('a spawn that fails short of its budget raises an error naming the command', () => {
    let thrown: unknown;
    try {
      spawnSyncBounded('bash', ['-c', OVERFLOWING_SCRIPT], {
        timeoutMs: WEDGE_BUDGET_MS,
        maxBuffer: 64,
      });
    } catch (error) {
      thrown = error;
    }

    expect(
      thrown,
      `node reports a non-timeout spawn failure on the result rather than by throwing, so a boundary that returns it hands a caller a partial result that reads as a whole one. maxBuffer is the reachable case and is not a reserved option: node caps the combined bytes of every captured stream at 1 MiB by default, and on overflow it stops reading, kills the child if it is still running, and hands back the truncated stream, which satisfies every assertion that only reads status and output. Returning it is what lets a partial run read as a whole one`,
    ).toBeInstanceOf(BoundedSpawnError);
    expect(
      (thrown as BoundedSpawnError).message,
      `the raised error must name the command it ran. Node's own message for this condition is 'spawnSync bash ENOBUFS', measured, which names the program and neither the script nor the layer that produced it, so re-throwing it unchanged reproduces the context-free failure the budget error was written to avoid`,
    ).toContain(`bash -c ${OVERFLOWING_SCRIPT}`);
    expect(
      ((thrown as BoundedSpawnError).cause as NodeJS.ErrnoException | undefined)?.code,
      "node's own diagnosis must survive the wrapping, because the errno is what separates an overflowing stream from a missing binary",
    ).toBe('ENOBUFS');
  });
});
