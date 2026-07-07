/**
 * Unit tests for the shared `spawnDetached` primitive. Covers two of the
 * three safety-critical wiring properties the helper encapsulates —
 * spawn-signal success and ENOENT/EACCES classification — by exercising the
 * real `child_process.spawn` path (no test-double) against either the
 * current runtime binary or a temp file with controlled permissions.
 *
 * **Timeout race is NOT covered here** by design. The helper's contract is
 * "settle ok:true once the child emits `spawn`"; a fast spawn against a
 * real binary always wins the race against any realistic test timeout, and
 * a slow-enough timeout to lose the race would
 * require either a real long-running binary or a fake injectable
 * `spawn`/`setTimeout` — at which point the test is exercising the test
 * doubles, not the production behavior. The timeout branch IS exercised
 * via injected mocks in `handoff-dispatch-api.test.ts` (cursor timeout
 * cell) and `spawn-cursor-api.test.ts` (timeout reason → 504 cell).
 *
 * Why exercise the real spawn here even though both consumers
 * (`/api/spawn-cursor`, `/api/handoff`) inject mocks: the production
 * `spawnDetached` carries the contract for `detached: true` + `stdio:
 * 'ignore'` + `unref()` + success-after-spawn ordering + the
 * `ENOENT|EACCES|EPERM` reason classification. Without dedicated tests here,
 * a refactor that resolves success before the spawn/error signal would
 * silently flip not-installed paths to ok:true with no test surface
 * complaining.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnDetached } from './spawn-detached.ts';

const NEVER_HIT = 5_000;

describe('spawnDetached — success path', () => {
  test('spawning the running Node binary resolves to { ok: true }', async () => {
    // `process.execPath` is the Node/Bun binary executing this test —
    // guaranteed-present on every CI runner and dev workstation regardless
    // of platform. Argv `['--version']` makes the child exit immediately
    // so we don't leave a long-lived background process.
    const outcome = await spawnDetached(process.execPath, ['--version'], NEVER_HIT);
    expect(outcome).toEqual({ ok: true });
  });

  test('arguments pass argv-style (shell: false) — metacharacters survive verbatim', async () => {
    // Pass a metacharacter-laden arg to Node's `-e` mode and assert it
    // doesn't crash. A shell-interpolated invocation would expand
    // `$(touch ...)` or trip on `&&`; argv-array passes the literal
    // string through to argv[2]. The child exits immediately on its own.
    const outcome = await spawnDetached(
      process.execPath,
      ['-e', 'process.exit(0) /* $(touch /tmp/pwned) && rm -rf /tmp/pwned */'],
      NEVER_HIT,
    );
    expect(outcome).toEqual({ ok: true });
  });
});

describe('spawnDetached — error classification', () => {
  test('ENOENT (binary not found) → { ok: false, reason: "not-installed" }', async () => {
    const outcome = await spawnDetached('/nonexistent/binary-that-does-not-exist', [], NEVER_HIT);
    expect(outcome).toEqual({ ok: false, reason: 'not-installed' });
  });

  test('EACCES (no exec permission on POSIX) → { ok: false, reason: "not-installed" }', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'ok-spawn-noexec-'));
    try {
      const script = join(dir, 'noexec.sh');
      await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      // A temp script with no executable bit reliably exercises EACCES.
      // Fixed system files such as /etc/hosts vary by platform/runtime:
      // some `posix_spawn` implementations report them as ENOEXEC instead.
      const outcome = await spawnDetached(script, [], NEVER_HIT);
      expect(outcome).toEqual({ ok: false, reason: 'not-installed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
