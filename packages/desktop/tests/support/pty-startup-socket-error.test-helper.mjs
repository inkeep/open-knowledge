import { errorMonitor } from 'node:events';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

let nativeSocket;
let forwardingSocket;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (args[0] === workerData.conoutPipeName) {
    nativeSocket = this;
    net.Socket.prototype.connect = connect;
  }
  return Reflect.apply(connect, this, args);
};
const createServer = net.createServer;
net.createServer = function (listener, ...args) {
  net.createServer = createServer;
  return Reflect.apply(createServer, this, [
    function (socket) {
      forwardingSocket = socket;
      return Reflect.apply(listener, this, [socket]);
    },
    ...args,
  ]);
};
parentPort.on('message', (surface) => {
  const socket = surface === 'native' ? nativeSocket : forwardingSocket;
  socket.once(errorMonitor, () => {
    setImmediate(() => parentPort.postMessage('socket-error-consumed'));
  });
  socket.destroy(new Error('owned output socket failed'));
});
await import(pathToFileURL(workerData.workerFile).href);
