
type Task<T> = () => Promise<T>;

class AsyncQueue {
  private _tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: Task<T>): Promise<T> {
    const next = this._tail.then(() => fn());
    this._tail = next.catch(() => undefined);
    return next;
  }
}

const _parentGitMutex = new AsyncQueue();

export function withParentLock<T>(fn: Task<T>): Promise<T> {
  return _parentGitMutex.enqueue(fn);
}
