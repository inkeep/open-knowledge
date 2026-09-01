import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decidePluginBaseline, openPluginBaselines } from './plugin-skill-baseline.ts';

describe('decidePluginBaseline', () => {
  it('first sight anchors to the current pair and reads clean', () => {
    const r = decidePluginBaseline(undefined, 'local-1', 'plugin-1');
    expect(r).toEqual({ modified: false, next: { local: 'local-1', upstream: 'plugin-1' } });
  });

  it('a local change while the upstream stands still is a hand-edit', () => {
    const r = decidePluginBaseline(
      { local: 'local-1', upstream: 'plugin-1' },
      'local-2',
      'plugin-1',
    );
    expect(r.modified).toBe(true);
    expect(r.next).toEqual({ local: 'local-1', upstream: 'plugin-1' });
  });

  it('an upstream move re-anchors instead of flagging the update wave', () => {
    const r = decidePluginBaseline(
      { local: 'local-1', upstream: 'plugin-1' },
      'local-2',
      'plugin-2',
    );
    expect(r).toEqual({ modified: false, next: { local: 'local-2', upstream: 'plugin-2' } });
  });

  it('an unchanged copy reads clean', () => {
    const r = decidePluginBaseline(
      { local: 'local-1', upstream: 'plugin-1' },
      'local-1',
      'plugin-1',
    );
    expect(r.modified).toBe(false);
  });
});

describe('openPluginBaselines', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists anchors across passes, so an edit flags on the NEXT scan too', () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-baseline-'));
    const pass1 = openPluginBaselines(dir);
    expect(pass1.isModified('project', 'analyze', 'local-1', 'plugin-1')).toBe(false);
    pass1.flush();

    const pass2 = openPluginBaselines(dir);
    expect(pass2.isModified('project', 'analyze', 'local-EDITED', 'plugin-1')).toBe(true);
    pass2.flush();

    const pass3 = openPluginBaselines(dir);
    expect(pass3.isModified('project', 'analyze', 'local-EDITED', 'plugin-1')).toBe(true);
  });

  it('scopes do not collide over one name', () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-baseline-'));
    const b = openPluginBaselines(dir);
    expect(b.isModified('project', 'x', 'p-local', 'up')).toBe(false);
    expect(b.isModified('global', 'x', 'g-local', 'up')).toBe(false);
    expect(b.isModified('project', 'x', 'p-local-2', 'up')).toBe(true);
    expect(b.isModified('global', 'x', 'g-local', 'up')).toBe(false);
  });

  it('a corrupt cache file is an empty cache, not a crash', () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-baseline-'));
    const b1 = openPluginBaselines(dir);
    b1.isModified('project', 'x', 'l1', 'u1');
    b1.flush();
    writeFileSync(join(dir, '.ok', 'local', 'plugin-skill-baselines.json'), '{not json');

    const b2 = openPluginBaselines(dir);
    expect(b2.isModified('project', 'x', 'l2', 'u1')).toBe(false);
  });

  it('a clean pass writes nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-baseline-'));
    const b1 = openPluginBaselines(dir);
    b1.isModified('project', 'x', 'l1', 'u1');
    b1.flush();
    const file = join(dir, '.ok', 'local', 'plugin-skill-baselines.json');
    const before = readFileSync(file, 'utf-8');

    const b2 = openPluginBaselines(dir);
    b2.isModified('project', 'x', 'l1', 'u1');
    b2.flush();
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});
