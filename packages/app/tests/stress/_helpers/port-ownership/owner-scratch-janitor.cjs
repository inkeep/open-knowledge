const fs = require('node:fs');
const path = require('node:path');

const [runDir, systemTempRoot] = process.argv.slice(2);
const resolved = fs.realpathSync(runDir);
if (
  path.dirname(resolved) !== fs.realpathSync(systemTempRoot) ||
  !path.basename(resolved).startsWith('ok-port-ownership-') ||
  fs.lstatSync(runDir).isSymbolicLink()
) {
  throw new Error('invalid owner scratch directory');
}

process.stdin.once('end', () => {
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
process.stdin.resume();
process.send('ready');
process.disconnect();
