import { describe, expect, test } from 'bun:test';
import { sep } from 'node:path';
import { classifyFsPath } from './fs-traced.ts';

/**
 * The classifier matches on path-segment substrings. The emitted bucket
 * labels (`'shadow-repo'`, `'ok-internal'`, `'lock'`, `'principal'`,
 * `'conflict'`, `'content-md'`, `'git'`, `'other'`) are load-bearing for
 * telemetry cardinality discipline — Tempo dashboards key off these strings.
 * If the labels drift, shadow-repo writes silently fall through to `'git'`
 * and break the dashboard split.
 */
describe('classifyFsPath', () => {
  // `sep` keeps these tests cross-platform — on macOS / Linux that's '/',
  // on Windows '\\'. The classifier uses `sep` consistently.
  const root = `${sep}tmp${sep}some-project`;

  test('shadow-repo writes bucket as "shadow-repo"', () => {
    expect(classifyFsPath(`${root}${sep}.git${sep}ok${sep}refs${sep}foo`)).toBe('shadow-repo');
    expect(classifyFsPath(`${root}${sep}.git${sep}ok${sep}HEAD`)).toBe('shadow-repo');
    expect(
      classifyFsPath(`${root}${sep}.git${sep}ok${sep}objects${sep}pack${sep}pack-abc.idx`),
    ).toBe('shadow-repo');
  });

  test('shadow-repo wins over the .lock check (lock-files inside .git/ok stay shadow-repo)', () => {
    // `index.lock` inside the shadow repo is part of git's atomic-write dance.
    // The classifier ladder must hit `shadow-repo` before the generic `.lock`
    // check or these writes would mis-bucket.
    expect(classifyFsPath(`${root}${sep}.git${sep}ok${sep}index.lock`)).toBe('shadow-repo');
  });

  test('main .git/ writes (not under .git/ok) bucket as "git"', () => {
    expect(classifyFsPath(`${root}${sep}.git${sep}HEAD`)).toBe('git');
    expect(classifyFsPath(`${root}${sep}.git${sep}objects${sep}pack${sep}pack-abc.idx`)).toBe(
      'git',
    );
  });

  test('.ok/local/server.lock buckets as "lock" (lock check fires before ok-internal)', () => {
    // The classifier checks `.lock` before `.ok` substring match, so
    // server.lock and ui.lock route to the lock bucket. This is intentional —
    // lock-related telemetry is its own concern; co-locating with cache /
    // conflicts state would blur signal.
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}server.lock`)).toBe('lock');
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}ui.lock`)).toBe('lock');
  });

  test('.ok/local/principal.json buckets as "principal"', () => {
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}principal.json`)).toBe('principal');
  });

  test('conflicts.json or paths under conflicts/ bucket as "conflict"', () => {
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}conflicts.json`)).toBe('conflict');
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}conflicts${sep}foo.md`)).toBe(
      'conflict',
    );
  });

  test('.ok/local/* general writes bucket as "ok-internal"', () => {
    expect(classifyFsPath(`${root}${sep}.ok${sep}config.yml`)).toBe('ok-internal');
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}cache${sep}foo.json`)).toBe(
      'ok-internal',
    );
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}state.json`)).toBe('ok-internal');
    expect(classifyFsPath(`${root}${sep}.ok${sep}local${sep}sync-state.json`)).toBe('ok-internal');
  });

  test('.md/.mdx writes UNDER .ok/ bucket as "ok-internal" (not content-md)', () => {
    // Internal-state markdown (e.g. a hypothetical .ok/AGENTS.md README) is
    // bookkeeping, not user content — its writes belong in the ok-internal
    // bucket. The .ok check must fire before the .md/.mdx check.
    expect(classifyFsPath(`${root}${sep}.ok${sep}AGENTS.md`)).toBe('ok-internal');
    expect(classifyFsPath(`${root}${sep}.ok${sep}cache${sep}foo.md`)).toBe('ok-internal');
    expect(classifyFsPath(`${root}${sep}.ok${sep}notes.mdx`)).toBe('ok-internal');
  });

  test('content-md and content-mdx writes bucket as "content-md"', () => {
    expect(classifyFsPath(`${root}${sep}docs${sep}guide.md`)).toBe('content-md');
    expect(classifyFsPath(`${root}${sep}README.mdx`)).toBe('content-md');
  });

  test('unrecognized paths bucket as "other"', () => {
    expect(classifyFsPath(`${root}${sep}other${sep}path.txt`)).toBe('other');
    expect(classifyFsPath(`${root}${sep}package.json`)).toBe('other');
  });
});
