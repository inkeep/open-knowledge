import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SkillLockEntry } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mutateSkillsLock, readSkillsLockFile } from './skills-lock-store.ts';

let base: string;
let lockPath: string;

const entry: SkillLockEntry = {
  source: '/sources/alpha',
  contentHash: 'hash-alpha',
  importedAt: '2026-09-08T00:00:00.000Z',
};

const seedLock = (contents: string): void => {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, contents, 'utf-8');
};

const record = (name: string, value: SkillLockEntry) =>
  mutateSkillsLock(lockPath, (lock) => ({ ...lock, skills: { ...lock.skills, [name]: value } }));

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ok-skills-lock-'));
  lockPath = join(base, '.ok', 'skills-lock.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('skills lock store', () => {
  test('an absent lock initializes an empty lock and records the first import', async () => {
    expect(existsSync(lockPath)).toBe(false);

    await record('alpha', entry);

    expect(readSkillsLockFile(lockPath).skills.alpha?.source).toBe('/sources/alpha');
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).schema).toBe(1);
  });

  test('a corrupt lock still reads as an empty lock', () => {
    seedLock('{ this is not json');

    expect(readSkillsLockFile(lockPath).skills).toEqual({});
  });

  test('recording over a corrupt lock refuses and leaves the file byte-identical', async () => {
    const truncated = '{"schema":1,"skills":{"beta":{"source":"/sources/be';
    seedLock(truncated);

    await expect(record('alpha', entry)).rejects.toThrow(/Refusing to rewrite/);
    expect(readFileSync(lockPath, 'utf-8')).toBe(truncated);
  });

  test('recording over a lock schema this server cannot read keeps every sibling import', async () => {
    const future = `${JSON.stringify(
      { schema: 2, skills: { beta: { source: '/sources/beta' } } },
      null,
      2,
    )}\n`;
    seedLock(future);

    await expect(record('alpha', entry)).rejects.toThrow(/Refusing to rewrite/);
    expect(readFileSync(lockPath, 'utf-8')).toBe(future);
  });

  test('a lock that cannot be opened at all refuses with the errno, not a parse verdict', async () => {
    mkdirSync(lockPath, { recursive: true });

    await expect(record('alpha', entry)).rejects.toThrow(
      /Refusing to rewrite .*: it could not be read \(EISDIR\)/,
    );
  });

  test('an entry field this server does not model survives a sibling record', async () => {
    seedLock(
      JSON.stringify({
        schema: 1,
        skills: { beta: { ...entry, source: '/sources/beta', futureField: 'keep-me' } },
      }),
    );

    await record('alpha', entry);

    const written = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(written.skills.beta.futureField).toBe('keep-me');
    expect(written.skills.alpha.source).toBe('/sources/alpha');
  });
});
