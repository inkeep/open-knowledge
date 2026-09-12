import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EDITOR_TARGETS } from './editors.ts';
import { removeOwnMcpEntry } from './mcp-config-removal.ts';
import { ensurePiBridge } from './pi-acp-bridge.ts';
import {
  commitPiTrustGrant,
  forgetPiTrustGrant,
  listPiTrustGrants,
  PiTrustReceiptError,
  preparePiTrustGrant,
} from './pi-trust-grants.ts';

describe('Pi trust grant receipts', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let configured: string;
  let canonical: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-grant-')));
    home = join(root, 'home');
    cwd = join(root, 'project');
    configured = join(home, '.pi', 'agent', 'trust.json');
    canonical = join(root, 'dotfiles', 'trust.json');
    mkdirSync(home);
    mkdirSync(cwd);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('makes direction controls visible when reporting a corrupt receipt path', () => {
    const displayHome = join(root, 'home\u202e');
    const receipt = preparePiTrustGrant(displayHome, cwd, configured, canonical, {
      present: false,
    });
    writeFileSync(receipt.path, '{');
    let failure: unknown;
    try {
      listPiTrustGrants(displayHome, cwd);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PiTrustReceiptError);
    if (!(failure instanceof PiTrustReceiptError)) throw new Error('receipt read did not fail');
    expect(failure.message).toContain('home\\u202e');
    expect(failure.message).not.toContain('\u202e');
    expect(failure.message).toContain('repair its JSON syntax');
    expect(readFileSync(receipt.path, 'utf8')).toBe('{');
  });

  test('persists a pending receipt before it can prove ownership, then commits it', () => {
    const pending = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    const hash = (path: string) => createHash('sha256').update(path).digest('hex');
    expect(pending.path).toBe(join(home, '.ok', 'pi-trust', hash(cwd), `${hash(canonical)}.json`));
    expect(JSON.parse(readFileSync(pending.path, 'utf8'))).toEqual({
      version: 1,
      cwd,
      configuredTrustPath: configured,
      canonicalTrustPath: canonical,
      state: 'pending',
      previous: { present: false },
    });
    expect(
      listPiTrustGrants(home, cwd).filter((receipt) => receipt.record.state === 'committed'),
    ).toEqual([]);

    const committed = commitPiTrustGrant(home, pending);

    expect(committed.record.state).toBe('committed');
    expect(listPiTrustGrants(home, cwd)).toEqual([committed]);
    if (process.platform !== 'win32') expect(statSync(committed.path).mode & 0o777).toBe(0o600);
  });

  test.each([false, null, { choice: 'previous', nested: [1, true] }])(
    'preserves the prior existing JSON decision %j',
    (value) => {
      const receipt = preparePiTrustGrant(home, cwd, configured, canonical, {
        present: true,
        value,
      });
      expect(listPiTrustGrants(home, cwd)[0]?.record.previous).toEqual({ present: true, value });
      expect(commitPiTrustGrant(home, receipt).record.previous).toEqual({ present: true, value });
    },
  );

  test('independent stores and projects keep independent pending and committed receipts', () => {
    const first = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    const second = preparePiTrustGrant(
      home,
      cwd,
      join(home, 'other', 'trust.json'),
      join(root, 'other-trust.json'),
      {
        present: true,
        value: false,
      },
    );
    const thirdCwd = join(root, 'another-project');
    const third = preparePiTrustGrant(home, thirdCwd, configured, canonical, { present: false });
    const committed = commitPiTrustGrant(home, first);

    expect(listPiTrustGrants(home, cwd)).toEqual(expect.arrayContaining([committed, second]));
    expect(listPiTrustGrants(home, cwd)).toHaveLength(2);
    expect(listPiTrustGrants(home, thirdCwd)).toEqual([third]);
    forgetPiTrustGrant(home, committed);
    expect(listPiTrustGrants(home, cwd)).toEqual([second]);
    expect(listPiTrustGrants(home, thirdCwd)).toEqual([third]);
  });

  test.each(['pending', 'committed'] as const)(
    'refuses to overwrite an existing %s receipt',
    (state) => {
      const pending = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
      const receipt = state === 'committed' ? commitPiTrustGrant(home, pending) : pending;
      const before = readFileSync(receipt.path, 'utf8');

      expect(() =>
        preparePiTrustGrant(home, cwd, configured, canonical, { present: true, value: false }),
      ).toThrow('already exists');
      expect(readFileSync(receipt.path, 'utf8')).toBe(before);
    },
  );

  test('refuses a changed receipt before commit or forget', () => {
    const pending = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    const changed = { ...pending.record, previous: { present: true, value: false } };
    writeFileSync(pending.path, JSON.stringify(changed));

    expect(() => commitPiTrustGrant(home, pending)).toThrow('changed while');
    expect(() => forgetPiTrustGrant(home, pending)).toThrow('changed while');
    expect(JSON.parse(readFileSync(pending.path, 'utf8'))).toEqual(changed);
  });

  test('retains a malformed receipt during reads, commit, and forget', () => {
    const pending = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    writeFileSync(pending.path, '{invalid');

    expect(() => listPiTrustGrants(home, cwd)).toThrow('is not valid JSON');
    expect(() => commitPiTrustGrant(home, pending)).toThrow('is not valid JSON');
    expect(() => forgetPiTrustGrant(home, pending)).toThrow('is not valid JSON');
    expect(() => listPiTrustGrants(home, cwd)).toThrow(PiTrustReceiptError);
    try {
      listPiTrustGrants(home, cwd);
    } catch (error) {
      expect(error).toMatchObject({
        cause: expect.any(SyntaxError),
        message: expect.stringContaining(
          'repair its JSON syntax without changing the recorded decision',
        ),
      });
      expect(error).toHaveProperty('message', expect.not.stringContaining('permissions'));
    }
    expect(readFileSync(pending.path, 'utf8')).toBe('{invalid');
  });

  test('rejects records stored under another project or filename', () => {
    const pending = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    const otherCwd = join(root, 'other');
    const other = preparePiTrustGrant(home, otherCwd, configured, canonical, { present: false });
    copyFileSync(pending.path, other.path);
    expect(() => listPiTrustGrants(home, otherCwd)).toThrow(
      'does not match its project or trust-store location',
    );
    const renamed = join(dirname(pending.path), `${'0'.repeat(64)}.json`);
    renameSync(pending.path, renamed);
    expect(() => listPiTrustGrants(home, cwd)).toThrow(
      'does not match its project or trust-store location',
    );
    expect(existsSync(renamed)).toBe(true);
    expect(existsSync(other.path)).toBe(true);
  });

  test.skipIf(process.platform === 'win32')(
    'refuses symlinked receipts and preserves their target',
    () => {
      const pending = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
      const target = join(root, 'receipt-copy.json');
      renameSync(pending.path, target);
      symlinkSync(target, pending.path);

      expect(() => listPiTrustGrants(home, cwd)).toThrow('is not a regular file');
      expect(() => forgetPiTrustGrant(home, pending)).toThrow('is not a regular file');
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(pending.record);
    },
  );

  test('ignores unrelated and atomic temporary files without modifying them', () => {
    const pending = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    const temporary = `${pending.path}.tmp.3fd292cf-19e2-47ef-bcfa-f338727da468`;
    const unrelated = join(dirname(pending.path), 'notes.txt');
    writeFileSync(temporary, 'unfinished atomic write');
    writeFileSync(unrelated, 'unrelated user data');

    expect(listPiTrustGrants(home, cwd)).toEqual([pending]);
    const committed = commitPiTrustGrant(home, pending);
    forgetPiTrustGrant(home, committed);

    expect(listPiTrustGrants(home, cwd)).toEqual([]);
    expect(readFileSync(temporary, 'utf8')).toBe('unfinished atomic write');
    expect(readFileSync(unrelated, 'utf8')).toBe('unrelated user data');
  });

  test('removes the bridge and recorded grant despite an interrupted receipt write', async () => {
    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).ok).toBe(true);
    const [receipt] = listPiTrustGrants(home, cwd);
    if (!receipt) throw new Error('expected committed receipt');
    const temporary = `${receipt.path}.tmp.2c814e13-d940-4e41-9bf7-dc3072e7c0e8`;
    writeFileSync(temporary, 'unfinished receipt write');
    const bridgePath = join(cwd, '.pi', 'extensions', 'open-knowledge.ts');

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePath)).toMatchObject({
      kind: 'removed',
      trust: 'removed',
    });
    expect(existsSync(bridgePath)).toBe(false);
    expect(JSON.parse(readFileSync(configured, 'utf8'))).toEqual({});
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
    expect(readFileSync(temporary, 'utf8')).toBe('unfinished receipt write');
  });

  test('reports invalid record fields and previous decisions without hiding their diagnosis', () => {
    const receipt = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    writeFileSync(receipt.path, JSON.stringify({ ...receipt.record, state: 'unknown' }));
    expect(() => listPiTrustGrants(home, cwd)).toThrow('has invalid contents');

    writeFileSync(receipt.path, JSON.stringify({ ...receipt.record, previous: { present: true } }));
    expect(() => listPiTrustGrants(home, cwd)).toThrow('has an invalid previous decision');
  });

  test('reports a missing receipt directory accurately before commit and forget', () => {
    const receipt = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    rmSync(dirname(receipt.path), { recursive: true });

    expect(() => commitPiTrustGrant(home, receipt)).toThrow('no longer exists');
    expect(() => forgetPiTrustGrant(home, receipt)).toThrow('no longer exists');
    expect(existsSync(dirname(receipt.path))).toBe(false);
  });

  test('reports a regular file in place of the receipt directory', () => {
    const path = join(home, '.ok', 'pi-trust');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'unrelated file');

    expect(() => listPiTrustGrants(home, cwd)).toThrow('is not a regular directory');
    expect(readFileSync(path, 'utf8')).toBe('unrelated file');
  });

  test.skipIf(process.platform === 'win32')(
    'refuses a receipt directory replaced by a symlink before commit and forget',
    () => {
      const receipt = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
      const directory = dirname(receipt.path);
      const target = join(root, 'moved-receipts');
      renameSync(directory, target);
      symlinkSync(target, directory);

      expect(() => commitPiTrustGrant(home, receipt)).toThrow('is not a regular directory');
      expect(() => forgetPiTrustGrant(home, receipt)).toThrow('is not a regular directory');
      expect(JSON.parse(readFileSync(receipt.path, 'utf8'))).toEqual(receipt.record);
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retains an unreadable receipt with actionable failure',
    () => {
      const receipt = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
      const before = readFileSync(receipt.path, 'utf8');
      chmodSync(receipt.path, 0o000);
      try {
        expect(() => listPiTrustGrants(home, cwd)).toThrow(
          'parent-directory permissions, then retry',
        );
        expect(() => forgetPiTrustGrant(home, receipt)).toThrow(
          'parent-directory permissions, then retry',
        );
      } finally {
        chmodSync(receipt.path, 0o600);
      }
      expect(readFileSync(receipt.path, 'utf8')).toBe(before);
    },
  );

  test('forgets only the receipt and empty receipt directories, leaving .ok and other state', () => {
    const receipt = preparePiTrustGrant(home, cwd, configured, canonical, { present: false });
    const keep = join(home, '.ok', 'keep.json');
    writeFileSync(keep, 'user state');

    forgetPiTrustGrant(home, receipt);

    expect(existsSync(receipt.path)).toBe(false);
    expect(existsSync(dirname(receipt.path))).toBe(false);
    expect(existsSync(join(home, '.ok', 'pi-trust'))).toBe(false);
    expect(readFileSync(keep, 'utf8')).toBe('user state');
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test('refuses non-JSON prior state before creating receipt storage', () => {
    expect(() =>
      preparePiTrustGrant(home, cwd, configured, canonical, { present: true, value: undefined }),
    ).toThrow('receipt');
    expect(existsSync(join(home, '.ok'))).toBe(false);
  });
});
