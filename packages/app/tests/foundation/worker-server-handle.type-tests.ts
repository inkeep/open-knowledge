import type { ChildProcess } from 'node:child_process';
import { killGracefully } from '../stress/_helpers/server-process.ts';
import {
  completeWorkerServerRelease,
  stopWorkerServer,
  type WorkerServerProcess,
} from '../stress/_helpers/worker-server-lifetime.ts';

declare const handle: WorkerServerProcess;
declare const command: ChildProcess;

void stopWorkerServer(handle, 1_000);
void completeWorkerServerRelease(handle);
void killGracefully(command, 1_000);
const _asChild: ChildProcess = handle;
void _asChild;

// @ts-expect-error -- a worker server handle is stopped through its lifetime owner; signalling its process group directly would bypass the release protocol.
void killGracefully(handle, 1_000);
// @ts-expect-error -- only a handle acquireWorkerServer returned has a lifetime owner to stop.
void stopWorkerServer(command, 1_000);
// @ts-expect-error -- only a handle acquireWorkerServer returned has a lifetime owner to release.
void completeWorkerServerRelease(command);
