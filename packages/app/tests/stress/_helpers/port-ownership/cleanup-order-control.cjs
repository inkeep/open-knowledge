const { meet } = require('./cleanup-order-gate.cjs');
const net = require('node:net');

const role = process.argv[2];
const socket = net.connect(
  {
    port: Number(process.env.OK_PORT_OWNERSHIP_SCHEDULE_PORT),
    host: '127.0.0.1',
  },
  () => socket.write(`${role}\t${process.pid}\n`),
);
socket.unref();
process.on('message', (message) => {
  if (message === 'finish') {
    process.disconnect();
    return;
  }
  meet(message);
  if (process.connected) process.send(message);
});
