export function createKeyedSerializer(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = chains.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
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
