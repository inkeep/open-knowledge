import type { ChildProcess } from 'node:child_process';

interface OwnedChild {
  child: ChildProcess;
  closed: Promise<void>;
}

export class LocalOpSubprocessLifetime {
  private readonly children = new Set<OwnedChild>();
  private readonly operations = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  get stopped(): boolean {
    return this.shuttingDown;
  }

  spawn<T extends ChildProcess>(launch: () => T): T {
    this.assertOpen();
    const child = launch();
    this.hold(child);
    return child;
  }

  execFile<T extends Promise<unknown> & { child: ChildProcess }>(launch: () => T): T {
    this.assertOpen();
    const request = launch();
    this.hold(request.child);
    return request;
  }

  begin(): () => void {
    this.assertOpen();
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.operations.add(completion);
    return () => {
      this.operations.delete(completion);
      finish();
    };
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.drain();
    return this.shutdownPromise;
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new Error('The server is shutting down.');
  }

  private hold(child: ChildProcess): void {
    let owned: OwnedChild;
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        this.children.delete(owned);
        resolve();
      });
    });
    owned = { child, closed };
    this.children.add(owned);
  }

  private async drain(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.children].map(async ({ child, closed }) => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          let signalError: Error | undefined;
          const onError = (error: Error) => {
            signalError = error;
          };
          child.on('error', onError);
          try {
            child.kill('SIGKILL');
            if (signalError) {
              throw new Error(`Could not stop auth subprocess ${child.pid} (${child.spawnfile})`, {
                cause: signalError,
              });
            }
          } finally {
            child.off('error', onError);
          }
        }
        if (child.exitCode === null && child.signalCode === null) {
          await Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            closed,
          ]);
        }
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          if (stream && !stream.destroyed) stream.destroy();
        }
        await closed;
      }),
    );
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'Auth subprocess shutdown failed');
    await Promise.allSettled(this.operations);
  }
}
