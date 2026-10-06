const { ChildProcess } = require('node:child_process');
const { fstatSync } = require('node:fs');

const key = 'OK_PORT_OWNERSHIP_LEASE_FD';
const inherited = process.env[key];

if (inherited !== undefined) {
  const fd = Number(inherited);
  if (!Number.isInteger(fd) || fd < 3) throw new Error('invalid owner scratch lease descriptor');
  fstatSync(fd);
  const spawn = ChildProcess.prototype.spawn;
  const spawnSyncBinding = process.binding('spawn_sync');
  const spawnSync = spawnSyncBinding.spawn;
  const withLeaseEnv = (options, index) => ({
    ...options,
    envPairs: [
      ...(options.envPairs ?? []).filter((pair) => !pair.startsWith(`${key}=`)),
      `${key}=${index}`,
    ],
  });

  ChildProcess.prototype.spawn = function (options) {
    const requested = options.stdio ?? 'pipe';
    let stdio;
    if (Array.isArray(requested)) {
      stdio = [...requested];
      while (stdio.length < 3) stdio.push(undefined);
    } else if (requested === 'inherit') {
      stdio = [0, 1, 2];
    } else if (['pipe', 'ignore', 'overlapped'].includes(requested)) {
      stdio = [requested, requested, requested];
    } else {
      return spawn.call(this, options);
    }
    const index = stdio.length;
    const result = spawn.call(this, { ...withLeaseEnv(options, index), stdio: [...stdio, fd] });
    if (this.stdio) this.stdio.length = index;
    return result;
  };

  spawnSyncBinding.spawn = function (options) {
    const index = options.stdio.length;
    const result = spawnSync.call(this, {
      ...withLeaseEnv(options, index),
      stdio: [...options.stdio, { type: 'fd', fd }],
    });
    if (result.output) result.output.length = index;
    return result;
  };
}
