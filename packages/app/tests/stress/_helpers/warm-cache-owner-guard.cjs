'use strict';

const OWNER_PID_ENV = 'OK_WARM_CACHE_OWNER_PID';
const POLL_INTERVAL_MS = 25;

function parseOwnerPid(value) {
  const ownerPid = Number(value);
  return Number.isInteger(ownerPid) && ownerPid > 1 ? ownerPid : undefined;
}

function exitForOwnerLoss(ownerPid) {
  process.stderr.write(
    `[warm-cache owner guard] pid ${process.pid} exiting on owner ESRCH; owner pid ${ownerPid}\n`,
  );
  process.exit(0);
}

function startOwnerGuard(ownerPid) {
  const poll = setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ESRCH') {
        clearInterval(poll);
        exitForOwnerLoss(ownerPid);
      }
    }
  }, POLL_INTERVAL_MS);
  poll.unref();
}

const ownerPid = parseOwnerPid(process.env[OWNER_PID_ENV]);
if (ownerPid !== undefined) startOwnerGuard(ownerPid);
