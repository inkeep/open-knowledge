const OWNER_EXIT_FALLBACK_MS = 30_000;

function createOwnerLossHandler({ pid, sendSignal, exit, schedule, cleanup, record }) {
  let handled = false;
  function safeRecord(event, values) {
    try {
      record(event, values);
    } catch {}
  }
  return () => {
    if (handled) return;
    handled = true;
    safeRecord('owner-control-closed');
    try {
      cleanup();
    } catch (error) {
      safeRecord('owner-cleanup-error', { message: String(error) });
    }
    if (!Number.isInteger(pid) || pid <= 1) {
      exit(0);
      return;
    }
    try {
      const fallback = schedule(() => exit(0), OWNER_EXIT_FALLBACK_MS);
      fallback.unref?.();
      sendSignal(pid, 'SIGTERM');
    } catch (error) {
      safeRecord('owner-signal-error', { message: String(error) });
      exit(0);
    }
  };
}

module.exports = { createOwnerLossHandler, OWNER_EXIT_FALLBACK_MS };
