/**
 * Run async work one-at-a-time per key.
 *
 * Every JSON state file this server owns is mutated read-whole → edit →
 * write-whole, with an await in the middle. Callers routinely fire several at
 * once — converting each of a skill's locations, installing several skills —
 * and unserialized they all read the same snapshot and then overwrite each
 * other, so only the last writer's edit survives. The surrounding work usually
 * succeeds (separate paths on disk), which makes the loss silent: the file ends
 * up disagreeing with what is actually there.
 *
 * The server is single-per-contentDir (`server.lock`), so an in-process chain
 * keyed by file path is enough; a store that other processes also write (the
 * user-global skill state, reachable from the CLI and the desktop app at once)
 * needs a real file lock instead.
 */
export function createKeyedSerializer(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = chains.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // The stored tail swallows errors so one failed run does not poison the
    // chain for the next caller. The failure still rejects the promise this
    // caller received.
    chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };
}
