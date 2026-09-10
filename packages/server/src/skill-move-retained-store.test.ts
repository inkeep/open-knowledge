import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  clearSkillMoveRetention,
  readSkillMoveRetention,
  recordSkillMoveRetention,
} from './skill-move-retained-store.ts';

let base: string;

const ledgerPath = () => join(base, '.ok', 'local', 'skill-move-retained.json');

const seedLedger = (contents: string): void => {
  mkdirSync(join(base, '.ok', 'local'), { recursive: true });
  writeFileSync(ledgerPath(), contents);
};

const record = {
  retainedAt: '2026-09-08T00:00:00.000Z',
  from: 'project:alpha',
  to: 'global:alpha',
  sourceState: 'intact' as const,
  reason: 'UNLINK_FAILED',
  retainedContentHash: 'hash-alpha',
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ok-move-retained-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('skill move retained store', () => {
  test('a recorded retention reads back its source state, origin and destination fingerprint', async () => {
    await recordSkillMoveRetention(base, 'global', 'alpha', record);

    expect(readSkillMoveRetention(base, 'global', 'alpha')).toEqual({
      state: 'record',
      record,
    });
  });

  test('a retention is keyed by destination identity, not by name alone', async () => {
    await recordSkillMoveRetention(base, 'global', 'alpha', record);

    expect(readSkillMoveRetention(base, 'project', 'alpha')).toEqual({ state: 'none' });
    expect(readSkillMoveRetention(base, 'global', 'beta')).toEqual({ state: 'none' });
  });

  test('the ledger lives under .ok/local and keeps the full payload for operators', async () => {
    await recordSkillMoveRetention(base, 'global', 'alpha', record);

    expect(existsSync(ledgerPath())).toBe(true);
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf-8'))).toEqual({
      schema: 1,
      retained: { 'global:alpha': record },
    });
  });

  test('clearing a retention removes it and leaves siblings intact', async () => {
    await recordSkillMoveRetention(base, 'global', 'alpha', record);
    await recordSkillMoveRetention(base, 'global', 'beta', {
      ...record,
      from: 'project:beta',
      to: 'global:beta',
    });

    await clearSkillMoveRetention(base, 'global', 'alpha');

    expect(readSkillMoveRetention(base, 'global', 'alpha')).toEqual({ state: 'none' });
    const beta = readSkillMoveRetention(base, 'global', 'beta');
    expect(beta.state === 'record' && beta.record.from).toBe('project:beta');
  });

  test('clearing an absent retention does not create a ledger', async () => {
    await clearSkillMoveRetention(base, 'global', 'alpha');

    expect(existsSync(ledgerPath())).toBe(false);
  });

  test('an unreadable ledger reads as unreadable, not as absent', () => {
    seedLedger('{ this is not json');

    expect(readSkillMoveRetention(base, 'global', 'alpha')).toEqual({
      state: 'unreadable',
      reason: 'it is not valid JSON',
    });
  });

  test('a ledger written by a schema this server does not understand reads as unreadable', () => {
    seedLedger(JSON.stringify({ schema: 2, retained: { 'global:alpha': record } }));

    expect(readSkillMoveRetention(base, 'global', 'alpha').state).toBe('unreadable');
  });

  test('recording over an unreadable ledger rejects and leaves the file byte-identical', async () => {
    const truncated = '{"schema":1,"retained":{"global:beta":{"sourceSt';
    seedLedger(truncated);

    await expect(recordSkillMoveRetention(base, 'global', 'alpha', record)).rejects.toThrow(
      /Refusing to rewrite/,
    );
    expect(readFileSync(ledgerPath(), 'utf-8')).toBe(truncated);
  });

  test('recording over a ledger this server cannot version-match leaves every sibling record intact', async () => {
    const future = `${JSON.stringify(
      {
        schema: 2,
        retained: {
          'global:beta': { ...record, from: 'project:beta', sourceState: 'catastrophic' },
        },
      },
      null,
      2,
    )}\n`;
    seedLedger(future);

    await expect(recordSkillMoveRetention(base, 'global', 'alpha', record)).rejects.toThrow(
      /Refusing to rewrite/,
    );
    expect(readFileSync(ledgerPath(), 'utf-8')).toBe(future);
  });

  test('a present record with an unusable source state degrades to unknown, not to absent', () => {
    seedLedger(
      JSON.stringify({
        schema: 1,
        retained: { 'global:alpha': { ...record, sourceState: 'totally-fine' } },
      }),
    );

    expect(readSkillMoveRetention(base, 'global', 'alpha')).toEqual({
      state: 'record',
      record: { ...record, sourceState: 'unknown' },
    });
  });

  test('a present key that is not a record still counts as a retention, not as an absence', () => {
    seedLedger(JSON.stringify({ schema: 1, retained: { 'global:alpha': 'wat' } }));

    expect(readSkillMoveRetention(base, 'global', 'alpha')).toEqual({
      state: 'record',
      record: {
        retainedAt: '',
        from: '',
        to: '',
        sourceState: 'unknown',
        reason: '',
        retainedContentHash: '',
      },
    });
  });

  test('a record with no usable origin reports it empty rather than inventing one', () => {
    seedLedger(
      JSON.stringify({ schema: 1, retained: { 'global:alpha': { sourceState: 'lossy' } } }),
    );

    expect(readSkillMoveRetention(base, 'global', 'alpha')).toEqual({
      state: 'record',
      record: {
        retainedAt: '',
        from: '',
        to: '',
        sourceState: 'lossy',
        reason: '',
        retainedContentHash: '',
      },
    });
  });

  test('concurrent records for different skills all survive', async () => {
    await Promise.all(
      ['alpha', 'beta', 'gamma'].map((name) =>
        recordSkillMoveRetention(base, 'global', name, {
          ...record,
          from: `project:${name}`,
          to: `global:${name}`,
        }),
      ),
    );

    for (const name of ['alpha', 'beta', 'gamma']) {
      const read = readSkillMoveRetention(base, 'global', name);
      expect(read.state === 'record' && read.record.from).toBe(`project:${name}`);
    }
  });
});
