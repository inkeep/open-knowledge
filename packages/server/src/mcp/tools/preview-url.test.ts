import { describe as _bunDescribe, afterEach, beforeEach, expect, test } from 'vitest';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in MCP
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test (test) at the
// 15-min timeout. Tests run normally locally; follow-up PR will migrate
// fixtures to execFileSync.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import {
  acquireServerLock,
  markServerLockDraining,
  updateServerLockPort,
} from '../../server-lock.ts';
import { acquireUiLock, markUiLockDraining, updateUiLockPort } from '../../ui-lock.ts';
import {
  encodeSkillRoute,
  resolvePreviewUrl,
  resolveSkillPreviewUrl,
  resolveUiInfo,
} from './preview-url.ts';

let tmpDir: string;
let lockDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-preview-url-'));
  lockDir = resolve(tmpDir, OK_DIR, LOCAL_DIR);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('resolvePreviewUrl — lock edges', () => {
  test('lock returns route-only url when ui.lock is bound', () => {
    // `previewUrl` is route-only — no scheme/host/port. The lock
    // is read only for reachability; a bound lock means the route is
    // navigable in a running UI.
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173);
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result).toEqual({ url: '/#/docs/a', source: 'lock' });
  });

  test('lock with port=0 returns null (no further sources)', () => {
    // The deployed-wiki `config` fallback was removed alongside the
    // `preview.baseUrl` schema field, so an unbound lock leaves nothing
    // for the resolver to return.
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result).toBeNull();
  });

  test('route is identical regardless of the lock port', () => {
    // Route-only: the port no longer rides the resolved url. Any bound
    // port produces the same `/#/<doc>` route.
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 4242);
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result?.url).toBe('/#/docs/a');
  });

  test('null when no lock present', () => {
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result).toBeNull();
  });

  test('never emits openknowledge:// scheme — the url is a bare route', () => {
    // Regression pin: the OK_ELECTRON_PROTOCOL_HOST short-circuit was dropped
    // because external agent in-app browsers can only render http(s) URLs.
    // Setting the env var here MUST NOT change resolver output — the resolved
    // url is now a route fragment with no scheme at all.
    const prior = process.env.OK_ELECTRON_PROTOCOL_HOST;
    try {
      process.env.OK_ELECTRON_PROTOCOL_HOST = '1';
      acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
      updateUiLockPort(lockDir, 5173);
      const result = resolvePreviewUrl('docs/a', { lockDir });
      expect(result?.source).toBe('lock');
      expect(result?.url.startsWith('/#/')).toBe(true);
      expect(result?.url.startsWith('openknowledge://')).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.OK_ELECTRON_PROTOCOL_HOST;
      else process.env.OK_ELECTRON_PROTOCOL_HOST = prior;
    }
  });
});

describe('resolveSkillPreviewUrl', () => {
  test('returns the route-only __skill__ url when ui.lock is bound', () => {
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173);
    expect(resolveSkillPreviewUrl('global', 'trip-log', { lockDir })).toEqual({
      url: '/#/__skill__/global/trip-log',
      source: 'lock',
    });
  });

  test('encodes the skill name per-segment and defaults nothing (scope passed in)', () => {
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173);
    expect(resolveSkillPreviewUrl('project', 'run tests', { lockDir })?.url).toBe(
      '/#/__skill__/project/run%20tests',
    );
  });

  test('null when no UI is running', () => {
    expect(resolveSkillPreviewUrl('project', 'x', { lockDir })).toBeNull();
  });

  test('encodeSkillRoute matches the app hash parser body (no leading #/)', () => {
    expect(encodeSkillRoute('global', 'trip-log')).toBe('__skill__/global/trip-log');
  });
});

describe('resolvePreviewUrl — docName encoding (via lock branch)', () => {
  beforeEach(() => {
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173);
  });

  test('simple nested path', () => {
    const result = resolvePreviewUrl('notes/meeting', { lockDir });
    expect(result?.url).toBe('/#/notes/meeting');
  });

  test('spaces and em-dashes encoded', () => {
    const result = resolvePreviewUrl('notes/My Doc — 2026', { lockDir });
    expect(result?.url).toBe('/#/notes/My%20Doc%20%E2%80%94%202026');
  });

  test('question marks and hash signs encoded per-segment', () => {
    const result = resolvePreviewUrl('weird/? name', { lockDir });
    expect(result?.url).toBe('/#/weird/%3F%20name');
  });

  test('percent literal encoded', () => {
    const result = resolvePreviewUrl('with%percent', { lockDir });
    expect(result?.url).toBe('/#/with%25percent');
  });
});

describe('resolvePreviewUrl — round-trip via docNameFromHash', () => {
  // Mirror of packages/app/src/lib/doc-hash.ts (docNameFromHash).
  function docNameFromHash(hash: string): string | null {
    if (!hash.startsWith('#/')) return null;
    const rest = hash.slice(2);
    const qmark = rest.indexOf('?');
    const encoded = qmark >= 0 ? rest.slice(0, qmark) : rest;
    if (!encoded) return null;
    try {
      return encoded.split('/').map(decodeURIComponent).join('/');
    } catch {
      return encoded;
    }
  }

  beforeEach(() => {
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173);
  });

  test.each([
    'docs/a',
    'notes/My Doc — 2026',
    'weird/name with spaces',
    'with#hash',
    'with%percent',
    'deeply/nested/path/here',
    'leading-dash',
    'unicode/日本語',
  ])('round-trip: %s', (docName: string) => {
    const result = resolvePreviewUrl(docName, { lockDir });
    expect(result).not.toBeNull();
    const hashIdx = result?.url.indexOf('#') ?? -1;
    expect(hashIdx).toBeGreaterThan(-1);
    const hash = result?.url.slice(hashIdx);
    const decoded = docNameFromHash(hash ?? '');
    expect(decoded).toBe(docName);
  });

  test('trailing slash docName: decoder is lossy but safe', () => {
    // Trailing slashes produce empty trailing segments. The decoder joins
    // back with '/' and the trailing empty segment survives. Verify round-trip
    // holds for this edge case too.
    const result = resolvePreviewUrl('trail/', { lockDir });
    const hash = result?.url.slice(result.url.indexOf('#'));
    expect(hash).toBe('#/trail/');
  });
});

describe('resolveUiInfo — surface-aware source chain', () => {
  test('prefers a server.lock advertising the ui surface (single-listener topology)', () => {
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: tmpDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    updateServerLockPort(lockDir, 6060, 'http://127.0.0.1:6060');
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: 'http://127.0.0.1:6060' });
  });

  test('server.lock without the ui surface falls through to ui.lock (sibling topology)', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir, capabilities: ['http', 'ws'] });
    updateServerLockPort(lockDir, 6060, 'http://127.0.0.1:6060');
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173, 'http://localhost:5173');
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: 'http://localhost:5173' });
  });

  test('pre-url ui.lock falls back to a port-derived localhost origin', () => {
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173);
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: 'http://localhost:5173' });
  });

  test('no lock at all yields a null base', () => {
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: null });
  });

  test('a draining holder is never returned from either branch (single-listener teardown)', () => {
    // Single-listener teardown marks BOTH locks draining on the same
    // process. The server.lock draining guard must not be defeated by
    // falling through to that same dying process's ui.lock.
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: tmpDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    updateServerLockPort(lockDir, 6060, 'http://127.0.0.1:6060');
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 6060, 'http://localhost:6060');
    markServerLockDraining(lockDir);
    markUiLockDraining(lockDir);
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: null });
  });

  test('server.lock with ui capability but no dialable origin (pre-bind) falls through to ui.lock', () => {
    // The window between acquireServerLock and updateServerLockPort: port 0,
    // no url, but the ui capability already declared. The null-origin case
    // must fall through to the ui.lock branch, not answer "no UI".
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: tmpDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173, 'http://localhost:5173');
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: 'http://localhost:5173' });
  });

  test('a draining ui.lock alone is not returned either', () => {
    acquireUiLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateUiLockPort(lockDir, 5173, 'http://localhost:5173');
    markUiLockDraining(lockDir);
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: null });
  });
});
