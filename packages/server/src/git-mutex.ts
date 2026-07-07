/**
 * Parent-git mutex — serializes all parent-git write operations.
 *
 * This module has no imports so it can be tested without simple-git.
 */

type Task<T> = () => Promise<T>;

class AsyncQueue {
  private _tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: Task<T>): Promise<T> {
    const next = this._tail.then(() => fn());
    // Swallow errors in the tail so one failure doesn't block subsequent tasks
    this._tail = next.catch(() => undefined);
    return next;
  }
}

const _parentGitMutex = new AsyncQueue();

/**
 * Serialize a parent-git write operation through the global mutex.
 * Prevents concurrent git index corruption.
 */
export function withParentLock<T>(fn: Task<T>): Promise<T> {
  return _parentGitMutex.enqueue(fn);
}
