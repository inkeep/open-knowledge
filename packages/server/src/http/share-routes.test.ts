import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { loggerFactory } from '../logger.ts';
import { SHARE_PUBLISH_TIMEOUT_MS } from '../share/publish.ts';
import { createShareRoutes, type ShareRouteDeps } from './share-routes.ts';

/**
 * Table-level pins for the share group's (empty) mutating declaration. The
 * wire cannot pin this: the read half of the DNS-rebinding defense applies
 * the identical loopback + workspace-Host checks to every `/api/*` request,
 * so a membership change alters no composition-suite response — only which
 * gate (and telemetry tag) fires first. `share/publish` staying OFF the
 * mutating set is deliberate legacy parity (external egress behind the
 * local-op pre-body gate, not content mutation), and this suite records that
 * membership as the byte-exact carry-over it is. Hardening `share/publish`
 * onto the mutating set later is a legitimate, separately-reviewed follow-up
 * (its Host check is universal today, so the wire outcome is unchanged) — this
 * pin marks the parity baseline to change deliberately, not a prohibition.
 */

function buildGroup(overrides: Partial<ShareRouteDeps> = {}) {
  return createShareRoutes({
    projectDir: undefined,
    contentDir: '/nonexistent-content',
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    localOpCliArgs: ['open-knowledge'],
    localOpGuard: { tryAcquire: () => true, release: () => {} },
    getSyncEngine: undefined,
    toGitRelativePath: () => null,
    ...overrides,
  });
}

describe('createShareRoutes table', () => {
  test('registers exactly the five share paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/share/construct-url',
        '/api/share/target-status',
        '/api/share/publish/owners',
        '/api/share/publish/name-check',
        '/api/share/publish',
      ].sort(),
    );
  });

  test('no share path is mutating — share/publish included, matching the legacy set', () => {
    const { table } = buildGroup();
    for (const path of [
      '/api/share/construct-url',
      '/api/share/target-status',
      '/api/share/publish/owners',
      '/api/share/publish/name-check',
      '/api/share/publish',
    ]) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});

describe('spawnShareSubprocess timeout settlement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Pins that the timer is a genuine SETTLE branch: a signal-resistant child
  // that never exits must still land the 500 and release the localOpGuard
  // slot. The fixture TRAPS SIGTERM — that is the discriminator: the pre-fix
  // shape's timer only sent SIGTERM and settled on 'close', so against this
  // child it hangs (the trap swallows the signal, 'close' never fires), while
  // the settle-at-timer shape rejects on the clock regardless. The `-e`
  // script ignores the appended share CLI argv. (What this proves: timeout
  // settlement + slot release against an uncooperative child. It does not
  // reproduce the harder wedge modes — D-state, grandchild-held stdio.)
  test('a SIGTERM-trapping, never-exiting subprocess times out to a 500 and releases the guard slot', async () => {
    // Fake ONLY the pair the handler's kill timer uses. setImmediate stays
    // real so the readiness wait below can make progress without moving the
    // faked clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const readyPath = join(tmpdir(), `ok-share-latch-ready-${randomUUID()}`);
    const acquired: string[] = [];
    const released: string[] = [];
    const group = buildGroup({
      localOpCliArgs: [
        process.execPath,
        '-e',
        // The trap must be INSTALLED before the clock advances, or the signal
        // hits the still-booting child's default disposition and the child
        // dies — making even the pre-fix settle-on-'close' shape pass. The
        // ready-file write after the trap is the barrier the test waits on.
        `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(
          readyPath,
        )}, 'x'); setInterval(() => {}, 1000);`,
      ],
      localOpGuard: {
        tryAcquire: (key: string) => {
          acquired.push(key);
          return true;
        },
        release: (key: string) => {
          released.push(key);
        },
      },
    });
    try {
      const resolved = group.table.resolve('/api/share/publish/owners');
      if (!resolved?.dispatch) throw new Error('no dispatch for /api/share/publish/owners');
      const req = makeSyntheticReq({ url: '/api/share/publish/owners', method: 'GET' });
      const { res, captured } = makeCaptureRes();
      const dispatched = resolved.dispatch(req, res);
      // Wait (real event loop, no faked clock) until the child has installed
      // its SIGTERM trap. Doubles as the spawn-succeeded checkpoint: in a
      // sandbox that refuses exec, 'error' fires instead, the same detail-less
      // 500 lands WITHOUT the timer branch ever running, and this barrier
      // never satisfies — the test fails on its own timeout rather than
      // greenlighting a path that proves nothing about settlement.
      while (!existsSync(readyPath)) {
        await new Promise((r) => setImmediate(r));
      }
      expect(released).toEqual([]);
      await vi.advanceTimersByTimeAsync(SHARE_PUBLISH_TIMEOUT_MS + 1);
      await dispatched;
      expect(captured.status).toBe(500);
      expect(acquired).toEqual(['/api/share/publish/owners']);
      expect(released).toEqual(['/api/share/publish/owners']);
    } finally {
      rmSync(readyPath, { force: true });
    }
  });
});
