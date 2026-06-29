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
    expect(isSafeLocalPath(`${home}/../etc`)).toBe(false);
  });
});


describe('isPathWithinHome — symlink containment', () => {
  let fakeHome: string;
  let outsideDir: string;

  beforeAll(() => {
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
    expect(isPathWithinHome(join(link, 'new-clone-target'), fakeHome)).toBe(false);
  });

  test('rejects path under a symlinked ancestor with a real subdir', () => {
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
    mkdirSync(outsideDir, { recursive: true });
  });

  test('rejects ../ traversal even when outside home', () => {
    expect(isPathWithinHome(`${fakeHome}/../etc`, fakeHome)).toBe(false);
  });

  test('allows the home dir itself', () => {
    expect(isPathWithinHome(fakeHome, fakeHome)).toBe(true);
  });
});


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
    const tmpOutside = mkdtempSync(join(realpathSync(tmpdir()), 'ok-symlinked-ancestor-'));
    try {
      const escapeLink = join(fakeHome, 'escape-symlink-ancestor');
      symlinkSync(tmpOutside, escapeLink);
      mkdirSync(join(tmpOutside, 'real-child'));
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
    const spy = spyErrnoOn(fakeHome, 'EPERM', 'realpathSync');
    try {
      expect(isPathWithinHome(join(fakeHome, 'anything'), fakeHome)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('ancestor chain lstat-throw during scan → fail-closed reject', () => {
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
