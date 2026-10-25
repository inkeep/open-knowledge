const { appendFileSync, existsSync } = require('node:fs');
const { tracingChannel } = require('node:diagnostics_channel');
const { isMainThread } = require('node:worker_threads');

const eventsPath = process.env.OK_TEST_WARM_CACHE_OWNER_LOSS_EVENTS;
const ownerPid = Number(process.env.OK_TEST_WARM_CACHE_OWNER_PID);
const expectedParent = Number.isInteger(ownerPid) && ownerPid > 1 ? ownerPid : process.ppid;
const chain = process.env.OK_TEST_WARM_CACHE_OWNER_LOSS_CHAIN === '1';
const cleanupPath = process.env.OK_TEST_WARM_CACHE_OWNER_LOSS_CLEANUP;
let changed = false;
let ownerLost = false;
let exited = false;

function write(event) {
  if (eventsPath === undefined || !isMainThread) return;
  appendFileSync(
    eventsPath,
    `${JSON.stringify({ event, pid: process.pid, ppid: process.ppid, time: Date.now() })}\n`,
  );
}

function observeOwnerLoss() {
  if (ownerLost || !Number.isInteger(ownerPid) || ownerPid <= 1) return;
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') {
      ownerLost = true;
      write({ kind: 'owner-lost', ownerPid });
    }
  }
}

write({ kind: 'loaded', chain, argv: process.argv });

const spawnChannel = tracingChannel('child_process.spawn');
spawnChannel.start.subscribe(({ process: child, options }) => {
  const isPnpm =
    options.file === 'pnpm' ||
    options.file.endsWith('/pnpm') ||
    options.args?.some((arg) => arg.endsWith('/pnpm')) === true;
  if (!chain && (!isPnpm || options.detached !== true)) return;
  const propagatedOwnerPid =
    chain && Number.isInteger(ownerPid) && ownerPid > 1 ? ownerPid : process.pid;
  if (Array.isArray(options.envPairs)) {
    options.envPairs = options.envPairs
      .filter((entry) => !entry.startsWith('OK_TEST_WARM_CACHE_OWNER_PID='))
      .filter((entry) => !entry.startsWith('OK_TEST_WARM_CACHE_OWNER_LOSS_CHAIN='))
      .concat(`OK_TEST_WARM_CACHE_OWNER_PID=${propagatedOwnerPid}`)
      .concat('OK_TEST_WARM_CACHE_OWNER_LOSS_CHAIN=1');
  }
  child.once('spawn', () => {
    write({
      kind: 'spawn',
      childPid: child.pid,
      file: options.file,
      args: options.args,
      detached: options.detached === true,
      chain: chain || isPnpm,
    });
  });
  child.once('exit', (code, signal) =>
    write({ kind: 'child-exit', childPid: child.pid, code, signal }),
  );
});

function finish(kind) {
  if (exited) return;
  exited = true;
  write({ kind });
  process.exit(0);
}

process.on('exit', () => {
  if (exited) return;
  observeOwnerLoss();
  exited = true;
  write({ kind: 'exit' });
});
process.on('SIGTERM', () => finish('signal:SIGTERM'));
process.on('SIGINT', () => finish('signal:SIGINT'));

const poll = setInterval(() => {
  if (process.ppid !== expectedParent && !changed) {
    changed = true;
    write({
      kind: 'parent-changed',
      expectedParent,
      currentParent: process.ppid,
      ownerLost: process.ppid === 1,
    });
    if (!chain) finish('parent-lost');
  }
  observeOwnerLoss();
}, 10);
poll.unref();

if (cleanupPath !== undefined) {
  const cleanup = setInterval(() => {
    if (existsSync(cleanupPath)) finish('guard-cleanup');
  }, 10);
  cleanup.unref();
}
