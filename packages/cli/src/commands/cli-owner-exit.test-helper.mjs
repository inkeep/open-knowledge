import { spawn } from 'node:child_process';

const preload = new URL('./cli-owner-preload.test-helper.mjs', import.meta.url).href;
const fixture = `
  const { writeSync } = require('node:fs');
  process.on('exit', (code) => writeSync(1, JSON.stringify({ code })));
  process.channel.ref();
  process.send('ready');
`;
setTimeout(
  () => {
    process.stderr.write('CLI owner-exit fixture liveness bound expired\n');
    process.exit(2);
  },
  Math.max(0, Number(process.argv[2]) - Date.now()),
);
const child = spawn(process.execPath, ['--import', preload, '--eval', fixture], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
child.once('message', () => process.exit(0));
