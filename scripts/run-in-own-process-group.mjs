import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { pathToFileURL } from 'node:url';

const RELAYED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function relayToHeldGroup(child, signal, send = process.kill.bind(process)) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    send(-child.pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    if (error?.code !== 'EPERM') throw error;
    process.stderr.write(
      `relaying ${signal} to process group ${child.pid} reported EPERM; treating the group as already gone\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const onWindows = process.platform === 'win32';
  const child = onWindows
    ? spawn([command, ...args].join(' '), { shell: true, stdio: 'inherit' })
    : spawn(command, args, { detached: true, stdio: 'inherit' });
  const relay = (signal) => relayToHeldGroup(child, signal);
  if (!onWindows) {
    for (const signal of RELAYED_SIGNALS) process.on(signal, relay);
  }
  child.on('exit', (code, signal) => {
    for (const relayed of RELAYED_SIGNALS) process.off(relayed, relay);
    process.exitCode = signal === null ? code : 128 + constants.signals[signal];
  });
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
