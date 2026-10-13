import { fork } from 'node:child_process';

const owner = fork(new URL('./shadow-fixture-owner.test-helper.mjs', import.meta.url), [], {
  execArgv: [],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
owner.on('message', (message) => {
  if (process.connected) process.send(message);
});
owner.once('close', (code) => {
  process.exitCode = code ?? 1;
  if (process.connected) process.disconnect();
});
process.on('message', (message) => {
  if (owner.connected) owner.send(message);
});
process.once('disconnect', () => {
  if (owner.connected) owner.disconnect();
});
