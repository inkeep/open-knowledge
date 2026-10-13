const { spawn } = require('node:child_process');
const {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join, relative, isAbsolute } = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { identifyAll, sameIdentity } = require('./process-identity.cjs');

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { dir, workDir, runId } = config;
const eventsPath = join(dir, 'events.jsonl');
const write = (name, value) => {
  const path = join(dir, name);
  writeFileSync(`${path}.pending`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.pending`, path);
};
const record = (value) =>
  appendFileSync(
    eventsPath,
    `${JSON.stringify({ at: Date.now(), pid: process.pid, runId, ...value })}\n`,
  );
const identify = (pids) => identifyAll(pids, eventsPath, runId);
const send = (value) => {
  if (process.connected) process.send({ runId, ...value }, () => {});
};
const events = () =>
  readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const owned = () => {
  const ids = new Map();
  for (const event of events()) {
    if (event.runId !== runId) throw new Error('foreign startup receipt');
    if (event.event !== 'spawn' && event.event !== 'runtime') continue;
    const id = event.identity;
    if (id?.found && id.pid !== process.pid) ids.set(`${id.pid}:${id.stamp}`, id);
  }
  return [...ids.values()];
};
const inventory = () => {
  const births = owned();
  const current = identify(births.map((birth) => birth.pid));
  return births.map((birth, index) => ({ birth, current: current[index] }));
};
const live = (rows) =>
  rows.filter((row) => sameIdentity(row.birth, row.current) && row.current.state !== 'Z');

record({ event: 'guardian-start', identity: identify([process.pid])[0] });
const bootstrap = join(dir, 'preload.cjs');
writeFileSync(
  bootstrap,
  `require(${JSON.stringify(join(__dirname, 'startup-observer.cjs'))}).install(${JSON.stringify({ eventsPath, runId })});\n`,
);
const fd = openSync(join(dir, 'subject.log'), 'a');
const command = {
  exe: process.execPath,
  args: config.args,
  cwd: config.cwd,
  environment: config.environment,
};
const child = spawn(command.exe, command.args, {
  cwd: command.cwd,
  env: {
    ...process.env,
    ...command.environment,
    TMPDIR: workDir,
    TMP: workDir,
    TEMP: workDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${bootstrap}`.trim(),
  },
  stdio: ['ignore', fd, fd],
});
const birth = identify([child.pid])[0];
record({
  event: 'spawn',
  identity: birth,
  command: command.exe,
  args: command.args,
  cwd: command.cwd,
  environment: command.environment,
});
write('command.json', { ...command, pid: child.pid, birth, runId, at: Date.now() });
child.once('exit', (code, signal) => {
  const exit = { code, signal, at: Date.now() };
  write('exit.json', exit);
  send({ type: 'subject-exit', exit });
});
child.once('error', (error) => {
  write('subject-error.json', { message: String(error) });
  void cleanup('subject spawn error');
});

let cleanupPromise;
let deadline;
async function performCleanup(reason) {
  clearTimeout(deadline);
  const before = inventory();
  const actions = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const row of live(inventory()).reverse()) {
      const verified = identify([row.birth.pid])[0];
      if (!sameIdentity(row.birth, verified) || verified.state === 'Z') continue;
      try {
        process.kill(row.birth.pid, signal);
        actions.push({ recorded: row.birth, verified, signal, at: Date.now() });
      } catch (error) {
        actions.push({
          recorded: row.birth,
          verified,
          signal,
          at: Date.now(),
          error: String(error),
        });
        if (error.code !== 'ESRCH') throw error;
      }
    }
    const until = Date.now() + (signal === 'SIGTERM' ? 3_000 : 2_000);
    while (live(inventory()).length !== 0 && Date.now() < until) await pause(50);
    if (live(inventory()).length === 0) break;
  }
  const after = inventory();
  const remaining = live(after);
  const resources = events().filter((event) => event.event === 'resource-created');
  const removals = [];
  if (remaining.length === 0) {
    for (const resource of resources) {
      if (!existsSync(resource.path)) continue;
      const within = relative(workDir, resource.path);
      const inWork = !isAbsolute(within) && within !== '..' && !within.startsWith('../');
      const workerCache =
        /^\.vite-(?:w\d+|prebuilt-serving)-/.test(resource.path.split('/').at(-1)) &&
        resource.path.includes('/packages/app/node_modules/');
      if ((!inWork && !workerCache) || lstatSync(resource.path).isSymbolicLink()) continue;
      if (resource.kind === 'file') {
        copyFileSync(
          resource.path,
          join(dir, `retained-server-${resource.pid}-${resource.fd}.log`),
        );
      }
      rmSync(resource.path, { recursive: resource.kind === 'directory', force: true });
      removals.push({ path: resource.path, absent: !existsSync(resource.path) });
    }
    rmSync(workDir, { recursive: true, force: true });
  }
  closeSync(fd);
  const receipt = {
    runId,
    reason,
    at: Date.now(),
    before,
    actions,
    after,
    liveSurvivors: remaining,
    resources,
    removals,
    workDirAbsent: !existsSync(workDir),
  };
  write('cleanup.json', receipt);
  send({ type: 'cleaned', receipt });
  if (process.connected) process.disconnect();
  process.exitCode = remaining.length === 0 ? 0 : 1;
  return receipt;
}

function cleanup(reason) {
  cleanupPromise ??= performCleanup(reason).catch((error) => {
    write('cleanup-error.json', { reason, message: String(error), stack: error.stack });
    if (process.connected) process.disconnect();
    process.exitCode = 1;
    throw error;
  });
  return cleanupPromise;
}

process.once('disconnect', () => void cleanup('outer owner disconnected'));
process.on('message', (message) => {
  if (message?.runId !== runId || message.type !== 'release') {
    throw new Error('invalid resource owner message');
  }
  void cleanup('normal release after observation');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void cleanup(`guardian received ${signal}`));
}
deadline = setTimeout(
  () => void cleanup('independent maximum lifetime reached'),
  config.deadlineMs,
);
send({ type: 'started', pid: process.pid, childPid: child.pid, birth });
