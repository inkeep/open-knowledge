import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkLocalOpSecurity,
  createConcurrencyGuard,
  hasValidLocalOpOrigin,
  isAllowedGitUrl,
  isLoopbackRequest,
  isPathWithinHome,
  isSafeLocalPath,
} from './local-op-security.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(remoteAddress: string, origin?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.socket = { remoteAddress } as IncomingMessage['socket'];
  req.headers = origin ? { origin } : {};
  return req;
}

interface CapturedResponse {
  status: number;
  contentType: string | undefined;
  body: unknown;
}

function makeRes(): {
  res: ServerResponse;
  calls: CapturedResponse[];
} {
  const calls: CapturedResponse[] = [];
  let lastStatus = 0;
  let lastHeaders: Record<string, string> = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      lastStatus = status;
      lastHeaders = headers;
    },
    end(body: string) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
      calls.push({
        status: lastStatus,
        contentType: lastHeaders['Content-Type'],
        body: parsed,
      });
    },
  } as unknown as ServerResponse;
  return { res, calls };
}

// ─── isLoopbackRequest ────────────────────────────────────────────────────────

describe('isLoopbackRequest', () => {
  test('allows 127.0.0.1', () => {
    expect(isLoopbackRequest(makeReq('127.0.0.1'))).toBe(true);
  });
  test('allows ::1', () => {
    expect(isLoopbackRequest(makeReq('::1'))).toBe(true);
  });
  test('allows ::ffff:127.0.0.1', () => {
    expect(isLoopbackRequest(makeReq('::ffff:127.0.0.1'))).toBe(true);
  });
  test('rejects external IPv4', () => {
    expect(isLoopbackRequest(makeReq('192.168.1.100'))).toBe(false);
  });
  test('rejects external IPv6', () => {
    expect(isLoopbackRequest(makeReq('2001:db8::1'))).toBe(false);
  });
});

// ─── hasValidLocalOpOrigin ────────────────────────────────────────────────────

describe('hasValidLocalOpOrigin', () => {
  test('allows absent origin', () => {
    expect(hasValidLocalOpOrigin(makeReq('127.0.0.1'))).toBe(true);
  });
  test('allows http://127.0.0.1:PORT', () => {
    expect(hasValidLocalOpOrigin(makeReq('127.0.0.1', 'http://127.0.0.1:3000'))).toBe(true);
  });
  test('allows http://localhost:PORT', () => {
    expect(hasValidLocalOpOrigin(makeReq('127.0.0.1', 'http://localhost:5173'))).toBe(true);
  });
  test('allows http://[::1]:PORT', () => {
    expect(hasValidLocalOpOrigin(makeReq('::1', 'http://[::1]:3000'))).toBe(true);
  });
  test('rejects external origin', () => {
    expect(hasValidLocalOpOrigin(makeReq('127.0.0.1', 'https://evil.example.com'))).toBe(false);
  });
  test('rejects non-loopback origin even on loopback socket', () => {
    expect(hasValidLocalOpOrigin(makeReq('127.0.0.1', 'http://192.168.1.1:3000'))).toBe(false);
  });
});

// ─── isAllowedGitUrl ──────────────────────────────────────────────────────────

describe('isAllowedGitUrl', () => {
  test('allows https URL', () => {
    expect(isAllowedGitUrl('https://github.com/owner/repo')).toBe(true);
  });
  test('allows http URL', () => {
    expect(isAllowedGitUrl('http://github.com/owner/repo')).toBe(true);
  });
  test('allows ssh URL', () => {
    expect(isAllowedGitUrl('ssh://git@github.com/owner/repo')).toBe(true);
  });
  test('allows git URL', () => {
    expect(isAllowedGitUrl('git://github.com/owner/repo')).toBe(true);
  });
  test('allows SCP-style git@', () => {
    expect(isAllowedGitUrl('git@github.com:owner/repo')).toBe(true);
  });
  test('allows SCP-style with subdomain', () => {
    expect(isAllowedGitUrl('git@github.example.com:owner/repo.git')).toBe(true);
  });
  test('rejects file:// URL', () => {
    expect(isAllowedGitUrl('file:///etc/passwd')).toBe(false);
  });
  test('rejects javascript: URL', () => {
    expect(isAllowedGitUrl('javascript:alert(1)')).toBe(false);
  });
  test('rejects ext:: URL', () => {
    expect(isAllowedGitUrl('ext::bash -c whoami')).toBe(false);
  });
  test('rejects data: URL', () => {
    expect(isAllowedGitUrl('data:text/plain,hello')).toBe(false);
  });
  test('rejects empty string', () => {
    expect(isAllowedGitUrl('')).toBe(false);
  });
  test('rejects bare path', () => {
    expect(isAllowedGitUrl('/etc/shadow')).toBe(false);
  });
});

// ─── isSafeLocalPath ─────────────────────────────────────────────────────────

describe('isSafeLocalPath', () => {
  const home = homedir();

  test('allows path within home dir', () => {
    expect(isSafeLocalPath(join(home, 'Documents', 'my-repo'))).toBe(true);
  });
  test('allows home dir itself', () => {
    expect(isSafeLocalPath(home)).toBe(true);
  });
  test('rejects path outside home dir', () => {
    expect(isSafeLocalPath('/etc/repo')).toBe(false);
  });
  test('rejects /tmp path', () => {
    expect(isSafeLocalPath('/tmp/evil')).toBe(false);
  });
  test('rejects empty string', () => {
    expect(isSafeLocalPath('')).toBe(false);
  });
  test('rejects path with null byte', () => {
    expect(isSafeLocalPath(`${home}/repo\0/evil`)).toBe(false);
  });
  test('rejects path that escapes via ..', () => {
    // Resolved path of home + '/../etc' lands outside home
    expect(isSafeLocalPath(`${home}/../etc`)).toBe(false);
  });
});

// ─── isPathWithinHome — realpath / symlink containment ───────────────────────
//
// Tests inject a tmp dir as `home` so symlink scenarios can be exercised
// without touching the developer's actual home. The public `isSafeLocalPath`
// is a thin wrapper over `isPathWithinHome(_, homedir())`; mocking `homedir()`
// is unreliable in Bun (no `$HOME` honoring after first call; `mock.module`
// leaks across files per server-factory.test.ts).

describe('isPathWithinHome — symlink containment', () => {
  let fakeHome: string;
  let outsideDir: string;

  beforeAll(() => {
    // realpath the tmpdir on macOS — `/var/folders/...` resolves to
    // `/private/var/folders/...`. Without this, paths under fakeHome compare
    // against a non-canonical $HOME and the containment check is unsound.
    const root = realpathSync(tmpdir());
    fakeHome = mkdtempSync(join(root, 'ok-local-op-home-'));
    outsideDir = mkdtempSync(join(root, 'ok-local-op-outside-'));
  });

  afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test('rejects symlink under home pointing outside home', () => {
    const link = join(fakeHome, 'decoy-etc');
    symlinkSync(outsideDir, link);
    expect(isPathWithinHome(link, fakeHome)).toBe(false);
  });

  test('rejects path under a symlinked ancestor that escapes home', () => {
    const link = join(fakeHome, 'decoy-parent');
    symlinkSync(outsideDir, link);
    // Suffix component does not exist — algorithm walks up to the symlink and
    // canonicalizes it. Containment check sees `<outsideDir>/new-clone-target`.
    expect(isPathWithinHome(join(link, 'new-clone-target'), fakeHome)).toBe(false);
  });

  test('rejects path under a symlinked ancestor with a real subdir', () => {
    // lstat follows symlinks in ancestor components and only reports
    // isSymbolicLink() for the leaf. With a symlinked ancestor and a real
    // (non-symlink) subdir inside its target, the walk-up sees the subdir as
    // a real directory, so a "skip realpath when leaf is non-symlink" branch
    // trusts the lexical path. The canonical on-disk location is outside
    // home and must be rejected.
    const link = join(fakeHome, 'escape');
    symlinkSync(outsideDir, link);
    mkdirSync(join(outsideDir, 'real-child'));
    expect(isPathWithinHome(join(link, 'real-child', 'clone-target'), fakeHome)).toBe(false);
  });

  test('allows symlink under home pointing to another path under home', () => {
    const inner = join(fakeHome, 'real-inside');
    mkdirSync(inner);
    const link = join(fakeHome, 'alias-inside');
    symlinkSync(inner, link);
    expect(isPathWithinHome(link, fakeHome)).toBe(true);
  });

  test('allows non-existent path under home (clone target)', () => {
    expect(isPathWithinHome(join(fakeHome, 'never-existed', 'sub', 'leaf'), fakeHome)).toBe(true);
  });

  test('rejects broken symlink under home', () => {
    const link = join(fakeHome, 'broken-link');
    symlinkSync(join(outsideDir, 'gone'), link);
    rmSync(outsideDir, { recursive: true, force: true });
    expect(isPathWithinHome(link, fakeHome)).toBe(false);
    // Re-create outsideDir so the afterAll cleanup remains a no-op-safe rm.
    mkdirSync(outsideDir, { recursive: true });
  });

  test('rejects ../ traversal even when outside home', () => {
    expect(isPathWithinHome(`${fakeHome}/../etc`, fakeHome)).toBe(false);
  });

  test('allows the home dir itself', () => {
    expect(isPathWithinHome(fakeHome, fakeHome)).toBe(true);
  });
});

// ─── isPathWithinHome — realpath syscall failure on non-symlink ──────────────
//
// macOS TCC ("Files and Folders") grants `lstat` on a protected directory but
// denies `realpath` (which performs per-component lstats after the entry
// point). The kernel reports the protected dir as `isSymbolicLink === false`
// via `lstat`, yet `realpath` raises EPERM. When the leaf is confirmed
// non-symlink by `lstat`, the EPERM is treated as TCC-class and the lexical
// path is trusted at that component — the kernel has already attested the
// leaf is not a redirector. Symlink leaves still fail closed on any
// `realpath` error.
//
// Reproducing TCC denial hermetically requires intercepting the syscall, so
// these tests spy on `fs.realpathSync` and throw an EPERM-shaped error for
// the target path while passing through for `realHome` and other paths the
// algorithm walks. The mock substitutes for an OS-level failure mode that is
// per-binary and environment-dependent (Bun on a fresh macOS install lacks
// the grant; Linux runners have no TCC layer at all).

describe('isPathWithinHome — realpath syscall failure on non-symlink', () => {
  let fakeHome: string;

  beforeAll(() => {
    const root = realpathSync(tmpdir());
    fakeHome = mkdtempSync(join(root, 'ok-local-op-realpath-fail-'));
  });

  afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function spyEpermOn(targetPath: string): { mockRestore: () => void } {
    const original = fs.realpathSync;
    return spyOn(fs, 'realpathSync').mockImplementation(((
      p: fs.PathLike,
      options?: unknown,
    ): string => {
      if (String(p) === targetPath) {
        const err = new Error(
          `EPERM: operation not permitted, lstat '${targetPath}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EPERM';
        err.errno = -1;
        err.syscall = 'lstat';
        err.path = targetPath;
        throw err;
      }
      return original(p as never, options as never) as string;
    }) as typeof fs.realpathSync);
  }

  test('lstat-confirmed non-symlink + realpath EPERM → accept (TCC-class)', () => {
    // Real on-disk directory under fakeHome; lstat sees `isSymbolicLink === false`.
    // realpath is mocked to throw EPERM only for this exact path, mirroring the
    // TCC syscall asymmetry: lstat allowed, realpath denied.
    const protectedDir = join(fakeHome, 'protected-non-symlink');
    mkdirSync(protectedDir);
    const spy = spyEpermOn(protectedDir);
    try {
      expect(isPathWithinHome(join(protectedDir, 'clone-target'), fakeHome)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('lstat-confirmed non-symlink + realpath EPERM on existing leaf → accept', () => {
    // The leaf itself exists (no walk-up needed) and is not a symlink. When
    // `realpath` raises EPERM under TCC, the lexical path is accepted at
    // that component because `lstat` has already attested the leaf is not a
    // redirector.
    const protectedLeaf = join(fakeHome, 'protected-leaf-dir');
    mkdirSync(protectedLeaf);
    const spy = spyEpermOn(protectedLeaf);
    try {
      expect(isPathWithinHome(protectedLeaf, fakeHome)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('lstat-confirmed non-symlink + realpath EACCES on existing leaf → accept (TCC-class)', () => {
    // Production code accepts both EPERM and EACCES for the TCC-class
    // accommodation. macOS may emit either depending on macOS version and
    // entitlement state. This test pins the EACCES arm so a future refactor
    // narrowing to EPERM-only is caught.
    const protectedLeaf = join(fakeHome, 'protected-leaf-eacces-dir');
    mkdirSync(protectedLeaf);
    const original = fs.realpathSync;
    const spy = spyOn(fs, 'realpathSync').mockImplementation(((
      p: fs.PathLike,
      options?: unknown,
    ): string => {
      if (String(p) === protectedLeaf) {
        const err = new Error(
          `EACCES: permission denied, lstat '${protectedLeaf}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        err.errno = -13;
        err.syscall = 'lstat';
        err.path = protectedLeaf;
        throw err;
      }
      return original(p as never, options as never) as string;
    }) as typeof fs.realpathSync);
    try {
      expect(isPathWithinHome(protectedLeaf, fakeHome)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('symlink + realpath error → still reject (defense-in-depth)', () => {
    // A symlink whose realpath fails must fail closed because the target is
    // unverifiable. The TCC-EPERM accommodation applies only to non-symlink
    // leaves where `lstat` has already attested the component is not a
    // redirector.
    const target = join(fakeHome, 'real-target');
    mkdirSync(target);
    const link = join(fakeHome, 'symlink-to-target');
    symlinkSync(target, link);
    const spy = spyEpermOn(link);
    try {
      expect(isPathWithinHome(join(link, 'leaf'), fakeHome)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('lstat EPERM on an existing path → reject (fail-closed)', () => {
    // Symmetric counterpart to the realpath EPERM accommodation: when `lstat`
    // itself is denied (the kernel does not attest whether the component is a
    // symlink), there is no basis to accept the lexical path. Pins the
    // fail-closed contract on the lstat boundary so a future refactor cannot
    // relax it into a `treat-EPERM-as-ENOENT-and-walk-up` bypass.
    const blocked = join(fakeHome, 'lstat-blocked-dir');
    mkdirSync(blocked);
    const originalLstat = fs.lstatSync;
    const spy = spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, options?: unknown) => {
      if (String(p) === blocked) {
        const err = new Error(
          `EPERM: operation not permitted, lstat '${blocked}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EPERM';
        err.errno = -1;
        err.syscall = 'lstat';
        err.path = blocked;
        throw err;
      }
      return originalLstat(p as never, options as never);
    }) as typeof fs.lstatSync);
    try {
      expect(isPathWithinHome(blocked, fakeHome)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('lstat-confirmed non-symlink under symlinked ancestor + realpath EPERM → still reject (security boundary)', () => {
    // Closes a security regression in the EPERM accept-branch: `lstat` follows
    // symlinks in ancestor components and only reports `isSymbolicLink === false`
    // for the leaf. With a symlinked ancestor whose target holds a real
    // (non-symlink) subdir, the kernel reports the subdir as non-symlink even
    // though its canonical location sits outside home.
    //
    // Setup: real `outsideDir/real-child` under outsideDir;
    // `fakeHome/escape-symlink-ancestor -> outsideDir` is a symlink under
    // home. Walking `fakeHome/escape-symlink-ancestor/real-child/clone-target`:
    //   iter 1: current=.../escape-symlink-ancestor/real-child/clone-target
    //           lstat ENOENT, suffix=[clone-target], walk up
    //   iter 2: current=.../escape-symlink-ancestor/real-child lstat
    //           (follows ancestor symlink) reports non-symlink, realpath
    //           mocked EPERM
    // Without the ancestor-chain scan, the accept-branch trusts the lexical
    // path and `relative(fakeHome, .../escape-symlink-ancestor/real-child) ===
    // 'escape-symlink-ancestor/real-child'` (no `..`, not absolute), so the
    // containment check returns true — yet canonical location is
    // `outsideDir/real-child`, outside fakeHome.
    const tmpOutside = mkdtempSync(join(realpathSync(tmpdir()), 'ok-symlinked-ancestor-'));
    try {
      const escapeLink = join(fakeHome, 'escape-symlink-ancestor');
      symlinkSync(tmpOutside, escapeLink);
      mkdirSync(join(tmpOutside, 'real-child'));
      // The path-through-the-symlinked-ancestor is what gets fed to realpath
      // when the algorithm walks up; mock EPERM on that exact lookup string.
      const realChildThroughLink = join(escapeLink, 'real-child');
      const spy = spyEpermOn(realChildThroughLink);
      try {
        expect(isPathWithinHome(join(escapeLink, 'real-child', 'clone-target'), fakeHome)).toBe(
          false,
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(tmpOutside, { recursive: true, force: true });
    }
  });

  test('lstat-confirmed non-symlink under symlinked ancestor + realpath EACCES → still reject (security boundary, EACCES arm)', () => {
    // Mirrors the EPERM ancestor-reject test but injects EACCES. Pins
    // the EACCES arm of the OR condition in the realpath catch — a future
    // refactor narrowing the ancestor-chain scan to EPERM-only would pass
    // the EACCES accept test but fail this one.
    const tmpOutside = mkdtempSync(join(realpathSync(tmpdir()), 'ok-symlinked-ancestor-eacces-'));
    try {
      const escapeLink = join(fakeHome, 'escape-symlink-ancestor-eacces');
      symlinkSync(tmpOutside, escapeLink);
      mkdirSync(join(tmpOutside, 'real-child'));
      const realChildThroughLink = join(escapeLink, 'real-child');
      const original = fs.realpathSync;
      const spy = spyOn(fs, 'realpathSync').mockImplementation(((
        p: fs.PathLike,
        options?: unknown,
      ): string => {
        if (String(p) === realChildThroughLink) {
          const err = new Error(
            `EACCES: permission denied, lstat '${realChildThroughLink}'`,
          ) as NodeJS.ErrnoException;
          err.code = 'EACCES';
          err.errno = -13;
          err.syscall = 'lstat';
          err.path = realChildThroughLink;
          throw err;
        }
        return original(p as never, options as never) as string;
      }) as typeof fs.realpathSync);
      try {
        expect(isPathWithinHome(join(escapeLink, 'real-child', 'clone-target'), fakeHome)).toBe(
          false,
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(tmpOutside, { recursive: true, force: true });
    }
  });
});

// ─── isPathWithinHome — fail-closed defensive guards ─────────────────────────
//
// Pins the fail-closed contract on three boundaries that are otherwise
// untested today: a non-EPERM realpath error on a non-symlink leaf must
// reject (unknown error codes are not granted the TCC accommodation); a
// home-dir realpath failure must reject every input (no realHome → no
// containment basis); an lstat throw during `ancestorChainHasSymlink`
// must fail closed inside the EPERM accept-branch.

describe('isPathWithinHome — fail-closed defensive guards', () => {
  let fakeHome: string;

  beforeAll(() => {
    const root = realpathSync(tmpdir());
    fakeHome = mkdtempSync(join(root, 'ok-local-op-failclosed-'));
  });

  afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function spyErrnoOn(
    targetPath: string,
    code: string,
    method: 'realpathSync' | 'lstatSync',
  ): { mockRestore: () => void } {
    if (method === 'realpathSync') {
      const original = fs.realpathSync;
      return spyOn(fs, 'realpathSync').mockImplementation(((
        p: fs.PathLike,
        options?: unknown,
      ): string => {
        if (String(p) === targetPath) {
          const err = new Error(
            `${code}: simulated, lstat '${targetPath}'`,
          ) as NodeJS.ErrnoException;
          err.code = code;
          err.syscall = 'lstat';
          err.path = targetPath;
          throw err;
        }
        return original(p as never, options as never) as string;
      }) as typeof fs.realpathSync);
    }
    const original = fs.lstatSync;
    return spyOn(fs, 'lstatSync').mockImplementation(((
      p: fs.PathLike,
      options?: unknown,
    ): fs.Stats => {
      if (String(p) === targetPath) {
        const err = new Error(`${code}: simulated, lstat '${targetPath}'`) as NodeJS.ErrnoException;
        err.code = code;
        err.syscall = 'lstat';
        err.path = targetPath;
        throw err;
      }
      return original(p as never, options as never) as fs.Stats;
    }) as typeof fs.lstatSync);
  }

  test('non-symlink + realpath EIO → reject (unknown error code, not TCC)', () => {
    // Only EPERM/EACCES are granted the TCC-class accommodation. Any other
    // realpath error code on a non-symlink leaf must fail closed — the
    // accept-branch is narrow by design, not a generic "trust lexical when
    // realpath misbehaves" hatch.
    const dir = join(fakeHome, 'eio-dir');
    mkdirSync(dir);
    const spy = spyErrnoOn(dir, 'EIO', 'realpathSync');
    try {
      expect(isPathWithinHome(dir, fakeHome)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('home dir realpath failure → reject all paths', () => {
    // realHome is the containment anchor; without it there is no basis to
    // judge any path. Pins the early-return at the realHome resolution site
    // against a future refactor that might fall back to a non-canonicalized
    // home string.
    const spy = spyErrnoOn(fakeHome, 'EPERM', 'realpathSync');
    try {
      expect(isPathWithinHome(join(fakeHome, 'anything'), fakeHome)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('ancestor chain lstat-throw during scan → fail-closed reject', () => {
    // Dual-spy: realpath EPERM on the leaf takes the algorithm into the
    // EPERM accept-branch, which calls `ancestorChainHasSymlink`. When the
    // ancestor walk's `lstat` throws (TCC denial on an intermediate
    // component), the function returns true (treat-as-symlink) and the
    // accept-branch rejects. Pins the catch inside `ancestorChainHasSymlink`
    // against a relaxation to "skip this component on error".
    const ancestor = join(fakeHome, 'mid-ancestor-failclosed');
    const leaf = join(ancestor, 'leaf-failclosed');
    mkdirSync(ancestor);
    mkdirSync(leaf);
    const realpathSpy = spyErrnoOn(leaf, 'EPERM', 'realpathSync');
    const lstatSpy = spyErrnoOn(ancestor, 'EPERM', 'lstatSync');
    try {
      expect(isPathWithinHome(leaf, fakeHome)).toBe(false);
    } finally {
      lstatSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });
});

// ─── checkLocalOpSecurity ────────────────────────────────────────────────────

describe('checkLocalOpSecurity', () => {
  test('allows loopback request with no origin', () => {
    const { res, calls } = makeRes();
    const result = checkLocalOpSecurity(makeReq('127.0.0.1'), res, { handler: 'test-handler' });
    expect(result).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('allows loopback request with valid origin', () => {
    const { res, calls } = makeRes();
    const result = checkLocalOpSecurity(makeReq('127.0.0.1', 'http://localhost:5173'), res, {
      handler: 'test-handler',
    });
    expect(result).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('rejects non-loopback request with RFC 9457 problem+json 403', () => {
    const { res, calls } = makeRes();
    const result = checkLocalOpSecurity(makeReq('10.0.0.5'), res, { handler: 'test-handler' });
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(403);
    expect(calls[0].contentType).toBe('application/problem+json');
    const body = calls[0].body as { type: string; title: string; status: number };
    expect(body.type).toBe('urn:ok:error:loopback-required');
    expect(body.title).toContain('loopback');
    expect(body.status).toBe(403);
  });

  test('rejects invalid origin with RFC 9457 problem+json 403', () => {
    const { res, calls } = makeRes();
    const result = checkLocalOpSecurity(makeReq('127.0.0.1', 'https://evil.example.com'), res, {
      handler: 'test-handler',
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(403);
    expect(calls[0].contentType).toBe('application/problem+json');
    const body = calls[0].body as { type: string; title: string; status: number };
    expect(body.type).toBe('urn:ok:error:invalid-origin');
    expect(body.title).toContain('Origin');
    expect(body.status).toBe(403);
  });
});

// ─── createConcurrencyGuard ───────────────────────────────────────────────────

describe('createConcurrencyGuard', () => {
  test('tryAcquire succeeds first time', () => {
    const guard = createConcurrencyGuard();
    expect(guard.tryAcquire('key1')).toBe(true);
  });

  test('tryAcquire fails when key already held', () => {
    const guard = createConcurrencyGuard();
    guard.tryAcquire('key1');
    expect(guard.tryAcquire('key1')).toBe(false);
  });

  test('tryAcquire succeeds again after release', () => {
    const guard = createConcurrencyGuard();
    guard.tryAcquire('key1');
    guard.release('key1');
    expect(guard.tryAcquire('key1')).toBe(true);
  });

  test('different keys are independent', () => {
    const guard = createConcurrencyGuard();
    guard.tryAcquire('key1');
    expect(guard.tryAcquire('key2')).toBe(true);
  });

  test('release of non-held key is a no-op', () => {
    const guard = createConcurrencyGuard();
    expect(() => guard.release('never-acquired')).not.toThrow();
  });
});
