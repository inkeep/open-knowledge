const { writeFileSync } = require('node:fs');
const http = require('node:http');
const { join } = require('node:path');

const nonce = process.argv[2];
const runDir = process.env.OK_PORT_OWNERSHIP_RUN_DIR;
if (!nonce || !runDir) throw new Error('lifetime server needs a nonce and run directory');

const server = http.createServer((request, response) => {
  if (request.url === `/release/${nonce}`) {
    clearTimeout(selfBound);
    writeFileSync(join(runDir, 'lifetime-release'), 'requested');
    response.end(nonce);
    response.once('finish', () => {
      server.closeAllConnections();
      server.close(() => {
        writeFileSync(join(runDir, 'lifetime-closed'), 'released');
        if (process.connected) process.disconnect();
      });
    });
    return;
  }
  response.end(nonce);
});

const selfBound = setTimeout(() => {
  writeFileSync(join(runDir, 'lifetime-self-bound'), 'expired');
  server.closeAllConnections();
  server.close(() => {
    if (process.connected) process.disconnect();
  });
}, 30_000);

server.listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port, nonce, pid: process.pid });
});

process.on('message', (message) => {
  if (message === 'release') {
    clearTimeout(selfBound);
    server.closeAllConnections();
    server.close(() => {
      writeFileSync(join(runDir, 'lifetime-closed'), 'normal');
      if (process.connected) process.disconnect();
    });
  }
});
