import { errorMonitor } from 'node:events';
import { writeSync } from 'node:fs';
import net from 'node:net';
import { getEnvironmentData, isMainThread, parentPort, workerData } from 'node:worker_threads';

const key = 'ok-pty-startup-worker-trace-v1';
const context = getEnvironmentData(key);
const pipeName = workerData?.conoutPipeName;

if (
  !isMainThread &&
  context?.tag === key &&
  Number.isSafeInteger(context.traceId) &&
  Number.isSafeInteger(context.attempt) &&
  typeof context.startedAt === 'number' &&
  typeof pipeName === 'string' &&
  pipeName.length > 0 &&
  context.counters instanceof SharedArrayBuffer
) {
  const state = new BigInt64Array(context.counters);
  if (state.length >= 11) {
    const nativeBytes = 0;
    const submittedBytes = 1;
    const nativeConnected = 2;
    const forwardingConnected = 3;
    const nativeClosed = 4;
    const forwardingClosed = 5;
    const nativeError = 6;
    const forwardingError = 7;
    const writerError = 8;
    const captureInstalled = 9;
    const persistedRecords = 10;
    const outputFd =
      Number.isSafeInteger(context.outputFd) && context.outputFd >= 0 ? context.outputFd : 1;
    let sequence = 0;
    const base = {
      event: 'pty-host-startup',
      traceId: context.traceId,
      attempt: context.attempt,
      backend: context.backend,
      producer: 'conout-worker',
    };
    const persist = (stage) => {
      sequence += 1;
      try {
        writeSync(
          outputFd,
          `PTY_HOST info ${JSON.stringify({
            ...base,
            stage,
            sequence,
            elapsedMs: performance.timeOrigin + performance.now() - context.startedAt,
            nativeBytes: Number(Atomics.load(state, nativeBytes)),
            workerSubmittedBytes: Number(Atomics.load(state, submittedBytes)),
          })}\n`,
        );
        Atomics.add(state, persistedRecords, 1n);
        Atomics.notify(state, persistedRecords);
      } catch {
        Atomics.store(state, writerError, 1n);
        Atomics.notify(state, writerError);
      }
    };
    Atomics.store(state, captureInstalled, 1n);
    persist('worker-preload-installed');
    if (parentPort) {
      const originalPostMessage = parentPort.postMessage;
      parentPort.postMessage = function (...args) {
        const result = Reflect.apply(originalPostMessage, this, args);
        if (args[0] === 1) {
          parentPort.postMessage = originalPostMessage;
          persist('worker-ready-sent');
        }
        return result;
      };
    }
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      if (args[0] !== pipeName) return Reflect.apply(originalConnect, this, args);
      net.Socket.prototype.connect = originalConnect;
      let firstRead = false;
      const originalPush = this.push;
      this.push = function (chunk, encoding) {
        if (chunk !== null) {
          Atomics.add(state, nativeBytes, BigInt(Buffer.byteLength(chunk, encoding)));
          Atomics.notify(state, nativeBytes);
          if (!firstRead) {
            firstRead = true;
            persist('worker-native-first-read');
          }
        }
        return Reflect.apply(originalPush, this, [chunk, encoding]);
      };
      this.on('connect', () => {
        Atomics.store(state, nativeConnected, 1n);
        persist('worker-native-pipe-connected');
      });
      this.on('close', () => Atomics.store(state, nativeClosed, 1n));
      this.on(errorMonitor, () => Atomics.store(state, nativeError, 1n));
      return Reflect.apply(originalConnect, this, args);
    };

    const originalCreateServer = net.createServer;
    net.createServer = function (...args) {
      net.createServer = originalCreateServer;
      const listener = args[0];
      if (typeof listener !== 'function') return Reflect.apply(originalCreateServer, this, args);
      const observedListener = function (socket) {
        Atomics.store(state, forwardingConnected, 1n);
        persist('worker-forwarding-socket-accepted');
        let firstSubmit = false;
        const originalWrite = socket.write;
        socket.write = function (chunk, ...writeArgs) {
          const result = Reflect.apply(originalWrite, this, [chunk, ...writeArgs]);
          Atomics.add(state, submittedBytes, BigInt(Buffer.byteLength(chunk)));
          Atomics.notify(state, submittedBytes);
          if (!firstSubmit) {
            firstSubmit = true;
            persist('worker-first-submit');
          }
          return result;
        };
        socket.on('close', () => Atomics.store(state, forwardingClosed, 1n));
        socket.on(errorMonitor, () => Atomics.store(state, forwardingError, 1n));
        return Reflect.apply(listener, this, [socket]);
      };
      return Reflect.apply(originalCreateServer, this, [observedListener, ...args.slice(1)]);
    };
  }
}
