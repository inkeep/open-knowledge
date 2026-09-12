import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mutateSkillPlacementsStore, readSkillPlacementsStore } from './skill-placements-store.ts';

let base: string;
let ledgerPath: string;

const seedLedger = (contents: string): void => {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, contents, 'utf-8');
};

const recordAlpha = () =>
  mutateSkillPlacementsStore(base, (store) => {
    store.skills.alpha = [{ path: '.claude/skills/alpha', mode: 'copy' }];
  });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ok-placements-'));
  ledgerPath = join(base, '.ok', 'local', 'skill-placements.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('skill placements store', () => {
  test('an absent ledger initializes and records the first placement', async () => {
    expect(existsSync(ledgerPath)).toBe(false);

    await recordAlpha();

    expect(readSkillPlacementsStore(base).skills.alpha).toEqual([
      { path: '.claude/skills/alpha', mode: 'copy' },
    ]);
    expect(JSON.parse(readFileSync(ledgerPath, 'utf-8')).schema).toBe(1);
  });

  test('a corrupt ledger still reads as an empty ledger', () => {
    seedLedger('{ this is not json');

    expect(readSkillPlacementsStore(base).skills).toEqual({});
  });

  test('mutating over a corrupt ledger refuses and leaves the file byte-identical', async () => {
    const truncated = '{"schema":1,"skills":{"beta":[{"path":".claude/skills/be';
    seedLedger(truncated);

    await expect(recordAlpha()).rejects.toThrow(/Refusing to rewrite/);
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(truncated);
  });

  test('mutating over an explicitly unsupported schema keeps every recorded placement', async () => {
    const future = `${JSON.stringify(
      { schema: 2, skills: { beta: [{ path: '.claude/skills/beta', mode: 'copy' }] } },
      null,
      2,
    )}\n`;
    seedLedger(future);

    await expect(recordAlpha()).rejects.toThrow(/Refusing to rewrite/);
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(future);
  });

  test('mutating over a top-level shape that is not a ledger leaves the file byte-identical', async () => {
    const notALedger = '["skills"]';
    seedLedger(notALedger);

    await expect(recordAlpha()).rejects.toThrow(/Refusing to rewrite/);
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(notALedger);
  });

  test('an invalid schema does not echo arbitrary ledger content in the refusal', async () => {
    const contents = '{"schema":{"privateValue":"private ledger text"},"skills":{}}';
    seedLedger(contents);

    await expect(recordAlpha()).rejects.toEqual(
      new Error(`Refusing to rewrite ${ledgerPath}: it declares an unsupported schema value`),
    );
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(contents);
  });

  test('a schema-less legacy ledger is still accepted and keeps its readable placements', async () => {
    seedLedger(
      JSON.stringify({ skills: { beta: [{ path: '.claude/skills/beta', mode: 'link' }] } }),
    );

    await recordAlpha();

    const written = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    expect(written.schema).toBe(1);
    expect(written.skills.beta).toEqual([{ path: '.claude/skills/beta', mode: 'link' }]);
    expect(written.skills.alpha).toEqual([{ path: '.claude/skills/alpha', mode: 'copy' }]);
  });

  test('a ledger that cannot be opened at all refuses with the errno, not a parse verdict', async () => {
    mkdirSync(ledgerPath, { recursive: true });

    await expect(recordAlpha()).rejects.toThrow(
      /Refusing to rewrite .*: it could not be read \(EISDIR\)/,
    );
  });

  test('a valid ledger still drops placements that escape the base on mutation', async () => {
    seedLedger(
      JSON.stringify({
        schema: 1,
        skills: {
          beta: [
            { path: '../outside/skills/beta', mode: 'copy' },
            { path: '.claude/skills/beta', mode: 'copy' },
          ],
        },
      }),
    );

    await recordAlpha();

    expect(JSON.parse(readFileSync(ledgerPath, 'utf-8')).skills.beta).toEqual([
      { path: '.claude/skills/beta', mode: 'copy' },
    ]);
  });
});
