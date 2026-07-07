/**
 * Pure shadow-repo fact readers.
 *
 * Dependency-light (git + node:fs only, no telemetry) so the out-of-process
 * `ok diagnose health` CLI can import them and read repo facts with OTel
 * disabled. `countShadowObjects` / `countWipRefs` / `hasGcLogLatch` are shared
 * with the maintenance coordinator; `countStaleAgentWipRefs` is the CLI's
 * disk-only dead-chain proxy (the coordinator computes dead chains from the
 * live keepalive map instead).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWriterId } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { ShadowHandle } from './shadow-repo.ts';
import { shadowGit } from './shadow-repo.ts';

export interface ShadowObjectStats {
  /** Loose (unpacked) objects — the count that degrades read latency as it grows. */
  looseObjects: number;
  /** On-disk size of loose objects, in KiB (git's `size`). */
  looseKiB: number;
  /** Number of packfiles. */
  packfiles: number;
  /** Objects stored inside packfiles. */
  packedObjects: number;
}

/** Parse `git count-objects -v` into structured loose/pack counts. */
export async function countShadowObjects(shadow: ShadowHandle): Promise<ShadowObjectStats> {
  const sg = shadowGit(shadow);
  const raw = await sg.raw('count-objects', '-v');
  const fields = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = Number.parseInt(line.slice(idx + 1).trim(), 10);
    if (key) fields.set(key, Number.isFinite(value) ? value : 0);
  }
  return {
    looseObjects: fields.get('count') ?? 0,
    looseKiB: fields.get('size') ?? 0,
    packfiles: fields.get('packs') ?? 0,
    packedObjects: fields.get('in-pack') ?? 0,
  };
}

/**
 * True when a `gc.log` latch is present. git writes it when a gc fails and then
 * refuses to auto-gc until the file self-expires (`gc.logExpiry`, ~1 day) — so
 * its presence means auto-gc is silently disabled and the repo can re-degrade.
 */
export function hasGcLogLatch(shadow: ShadowHandle): boolean {
  return existsSync(resolve(shadow.gitDir, 'gc.log'));
}

/**
 * Count WIP refs — the "width" of the journal. `branch` scopes to one branch's
 * refs (`refs/wip/<branch>/`); omit it to count every branch's WIP refs.
 */
export async function countWipRefs(shadow: ShadowHandle, branch?: string): Promise<number> {
  const sg = shadowGit(shadow);
  const pattern = branch ? `refs/wip/${branch}/` : 'refs/wip/';
  try {
    const raw = await sg.raw('for-each-ref', '--format=%(refname)', pattern);
    return raw.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Count "dead" AGENT chains from disk — the diagnose signal for "auto-
 * consolidation is not keeping up," computed WITHOUT the server's live keepalive
 * map (the CLI runs out of process and has no access to it). A live `agent-*`
 * session advances its WIP ref's tip on every write, so an `agent-*` ref whose
 * tip stopped advancing before `cutoffMs` is one the dead-chain auto-
 * consolidation path should already have folded — i.e. a dead chain maintenance
 * has not reaped.
 *
 * AGENT chains only, deliberately. Auto-consolidation folds dead agents on a
 * ~10-min cadence, so a 30-min staleness window is the right lag signal for
 * them. `principal-*` chains are NOT counted: they are folded by the 30-day TTL
 * backstop, never the fast auto path, so a 30-min-stale principal ref is
 * expected, not a degradation. Non-session writers (`file-system`,
 * `git-upstream`, the service writer) and park-tipped refs are excluded too.
 * This is the strict dead-AGENT-chain signal, not raw width — it stays near
 * zero under heavy live load (the false-positive that made total ref count the
 * wrong consolidation trigger). Branch-agnostic — scans every
 * `refs/wip/<branch>/`, mirroring `countWipRefs`'s default.
 */
export async function countStaleAgentWipRefs(
  shadow: ShadowHandle,
  cutoffMs: number,
): Promise<number> {
  const sg = shadowGit(shadow);
  let lines: string[];
  try {
    lines = (
      await sg.raw(
        'for-each-ref',
        '--format=%(refname)%00%(committerdate:unix)%00%(contents:subject)',
        'refs/wip/',
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of lines) {
    const [refname = '', committerUnix = '', subject = ''] = line.split('\x00');
    if (subject.startsWith('park:')) continue; // branch-switch state — never folded
    // refs/wip/<branch>/<writerId> — writerId may itself contain slashes.
    const writerId = refname.split('/').slice(3).join('/');
    if (!writerId) continue;
    if (parseWriterId(writerId).classification !== 'agent') continue;
    const unix = Number.parseInt(committerUnix, 10);
    if (!Number.isFinite(unix)) continue; // unparseable date — do not treat as stale
    if (unix * 1000 < cutoffMs) count += 1;
  }
  return count;
}
