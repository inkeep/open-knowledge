const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function identifyAll(pids, eventsPath, runId) {
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 1)) {
    throw new Error('identity requires positive process IDs');
  }
  if (pids.length === 0) return [];
  if (process.platform === 'darwin') {
    const result = spawnSync(
      '/usr/bin/python3',
      [join(__dirname, 'process-identity.py'), ...pids.map(String)],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(eventsPath === undefined
            ? {}
            : { OK_LIFETIME_IDENTITY_EVENTS: eventsPath, OK_LIFETIME_IDENTITY_RUN: runId }),
        },
      },
    );
    if (result.status !== 0) throw new Error(`identity sampler failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  if (process.platform === 'linux') {
    return pids.map((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        return {
          pid,
          ppid: Number(fields[1]),
          uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]),
          stamp: fields[19],
          state: fields[0],
          found: true,
        };
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
        return { pid, found: false };
      }
    });
  }
  throw new Error(`no native process identity substrate for ${process.platform}`);
}

function sameIdentity(recorded, current) {
  return (
    recorded.found === true &&
    current.found === true &&
    recorded.pid === current.pid &&
    recorded.uid === current.uid &&
    recorded.stamp === current.stamp
  );
}

module.exports = { identifyAll, sameIdentity };
