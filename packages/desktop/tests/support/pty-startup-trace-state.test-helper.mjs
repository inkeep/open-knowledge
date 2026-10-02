import net from 'node:net';
import { parentPort } from 'node:worker_threads';

const connect = net.Socket.prototype.connect;
const createServer = net.createServer;
await import('./pty-startup-trace-preload.test-helper.mjs');
parentPort.postMessage({
  connectUnchanged: net.Socket.prototype.connect === connect,
  serverUnchanged: net.createServer === createServer,
});
