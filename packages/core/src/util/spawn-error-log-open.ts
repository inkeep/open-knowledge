import { fchmodSync, openSync, statSync, writeSync } from 'node:fs';
import { formatSpawnAttemptHeader, spawnErrorLogOpenMode } from '../constants/lifecycle.ts';

/**
 * Open `SPAWN_ERROR_LOG` for one spawn attempt.
 *
 * Node-only, and shared rather than repeated: both documented writers of that
 * file must agree on the whole sequence, not just the predicates. Stat failure
 * handling, the file mode, and whether a missing header is fatal are each a
 * decision that would otherwise be re-made per site, and two sites that drift
 * on any of them put the retry-destroys-evidence defect back on one path.
 */
export function openSpawnErrorLog(path: string, spawningPid: number): number {
  let existingSize: number | undefined;
  try {
    existingSize = statSync(path).size;
  } catch {
    // Deliberately undifferentiated: append is correct whether the file is
    // absent or merely unstattable, so nothing here needs to tell them apart.
    existingSize = undefined;
  }
  const fd = openSync(path, spawnErrorLogOpenMode(existingSize), 0o600);
  try {
    // A child's stderr carries absolute paths and can carry env-derived values,
    // and this file sits beside a `server.lock` written 0600 for that reason.
    // `open(2)` honours `mode` only when it CREATES the file, and the common
    // path here is append onto one that already exists — including one an older
    // release created at the default 0644. Nothing else would repair that: the
    // size cap reopens with `'w'`, which truncates the contents and leaves the
    // mode exactly as it found it.
    //
    // Unconditional rather than gated on the file being loose. Skipping the
    // already-private case would save one `fchmod(2)` immediately before a
    // `fork`/`exec` that costs orders of magnitude more, and would buy it with
    // a stat result kept alive past the open for a branch ending at the same fd
    // either way.
    //
    // Permission semantics here are POSIX's. Windows models them differently,
    // so this is best-effort there; the file lives under the project directory
    // the user chose, not under their profile, so no profile-level ACL can be
    // assumed to be doing this job instead.
    fchmodSync(fd, 0o600);
  } catch {
    // A filesystem that cannot chmod, or a file this euid does not own, still
    // gets its spawn: the mode is hardening, not a precondition for logging.
  }
  try {
    writeSync(fd, formatSpawnAttemptHeader(new Date(), spawningPid));
  } catch {
    // A header we could not write is not worth failing a spawn over — the
    // child's stderr still lands on this fd, which is the part that matters.
    // The cost is that this attempt's output merges into the one before it,
    // since readers bound an attempt by the nearest preceding header.
  }
  return fd;
}
