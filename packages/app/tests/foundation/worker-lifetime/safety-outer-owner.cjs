const { fork } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const [configPath, guardianPath = join(__dirname, 'resource-owner.cjs')] = process.argv.slice(2);
const { runId } = JSON.parse(readFileSync(configPath, 'utf8'));
const guardian = fork(guardianPath, [configPath], {
  execArgv: [],
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
guardian.on('message', (message) => {
  if (process.connected) process.send(message);
});
guardian.once('exit', (code) => {
  if (process.connected) process.disconnect();
  process.exitCode = code;
});
process.on('message', (message) => {
  if (message?.runId !== runId || message.type !== 'release')
    throw new Error('invalid safety owner message');
  guardian.send(message);
});
