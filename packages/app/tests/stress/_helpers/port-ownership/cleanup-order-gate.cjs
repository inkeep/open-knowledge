const { execFileSync } = require('node:child_process');
const net = require('node:net');

function meet(phase) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.DYLD_INSERT_LIBRARIES;
  delete env.LD_PRELOAD;
  execFileSync(process.execPath, [__filename, phase, String(process.pid)], { env });
}

if (require.main === module) {
  const phase = process.argv[2];
  const pid = process.argv[3] ?? String(process.pid);
  let acknowledged = false;
  const socket = net.connect(
    { port: Number(process.env.OK_PORT_OWNERSHIP_SCHEDULE_PORT), host: '127.0.0.1' },
    () => socket.write(`${phase}\t${pid}\n`),
  );
  socket.once('data', (data) => {
    acknowledged = data[0] === 33;
  });
  socket.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  socket.once('close', () => {
    if (!acknowledged) process.exitCode = 1;
  });
}

module.exports = { meet };
