require('./owner-scratch-lease.cjs');
const net = require('node:net');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const { syncBuiltinESMExports } = require('node:module');
const { createOwnerLossHandler } = require('./owner-lifetime.cjs');

const createServer = net.createServer;
const spawn = childProcess.spawn;
const listenHttp = http.Server.prototype.listen;
const caller = process.env.OK_PORT_OWNERSHIP_CALLER;
const records = process.env.OK_PORT_OWNERSHIP_RECORDS;
const occupants = new Map();
const controlPort = Number(process.env.OK_PORT_OWNERSHIP_CONTROL_PORT);

function record(event, values = {}) {
  if (records)
    fs.appendFileSync(records, `${JSON.stringify({ event, pid: process.pid, ...values })}\n`);
}

if (Number.isInteger(controlPort) && controlPort > 0) {
  const control = net.connect({ port: controlPort, host: '127.0.0.1', allowHalfOpen: true });
  const leave = createOwnerLossHandler({
    pid: process.pid,
    sendSignal: (pid, signal) => process.kill(pid, signal),
    exit: (code) => process.exit(code),
    schedule: (callback, ms) => setTimeout(callback, ms),
    record,
    cleanup: () => {},
  });
  control.once('error', leave);
  control.once('end', leave);
  control.once('close', leave);
  control.unref();
}

net.createServer = function (...args) {
  const server = createServer.apply(this, args);
  if (!caller || !(new Error().stack ?? '').includes(caller)) return server;

  const close = server.close;
  server.close = (callback) => {
    const address = server.address();
    if (!address || typeof address === 'string') return close.call(server, callback);
    return close.call(server, (...closeArgs) => {
      const occupant = createServer((socket) => socket.destroy());
      occupant.once('error', (error) => {
        record('occupant-error', { port: address.port, code: error.code });
        throw error;
      });
      occupant.listen(address.port, address.address, () => {
        occupants.set(address.port, occupant);
        occupant.unref();
        record('occupied', { port: address.port, host: address.address });
        callback(...closeArgs);
      });
    });
  };
  return server;
};

childProcess.spawn = function (...args) {
  const [command, argv, options] = args;
  const port = Number(options?.env?.VITE_PORT);
  const occupant = occupants.get(port);
  if (command === 'pnpm' && argv?.includes('dev') && occupant?.listening) {
    record('dev-spawn', { port, command, argv, occupied: true });
  }
  const child = spawn.apply(this, args);
  if (command === 'pnpm' && argv?.includes('dev') && occupant) {
    child.once('exit', (code, signal) => {
      record('dev-exit', { port, code, signal });
      occupant.close(() => record('released', { port }));
      occupants.delete(port);
    });
  }
  return child;
};

let bindTakeoverComplete = false;
http.Server.prototype.listen = function (...args) {
  const rawRequest = process.env.OK_TEST_VITE_START_REQUEST;
  if (!rawRequest || bindTakeoverComplete) return listenHttp.apply(this, args);
  const request = JSON.parse(rawRequest);
  const port = args[0];
  if (typeof port !== 'number' || port < request.candidatePort) return listenHttp.apply(this, args);
  record('vite-bind-attempt', { port, candidatePort: request.candidatePort, host: request.host });
  const occupant = createServer((socket) => socket.destroy());
  occupant.once('error', (error) => {
    record('vite-bind-takeover-error', { port, code: error.code });
    this.emit('error', error);
  });
  occupant.listen(port, request.host, () => {
    occupants.set(port, occupant);
    occupant.unref();
    record('vite-bind-takeover', { port, host: request.host });
    bindTakeoverComplete = true;
    listenHttp.apply(this, args);
  });
  return this;
};

syncBuiltinESMExports();
