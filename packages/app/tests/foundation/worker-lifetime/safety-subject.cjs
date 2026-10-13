const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');

const dir = process.env.OK_LIFETIME_SAFETY_DIR;
const role = process.argv[2] ?? 'parent';
const server = createServer((_request, response) => response.end(role));
server.listen(0, '127.0.0.1', () => {
  writeFileSync(
    join(dir, `safety-${role}.json`),
    JSON.stringify({ pid: process.pid, port: server.address().port }),
  );
  if (role === 'parent') {
    spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore', env: process.env });
  }
});
process.on('SIGTERM', () => {});
