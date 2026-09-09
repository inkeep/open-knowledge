import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, test } from 'vitest';
import { escapeDisplayPath } from '../utils/escape-display-path.ts';
import { commitPiTrustGrant, preparePiTrustGrant } from './pi-trust-grants.ts';
import { deinitOps, type RemovalOp, type RemovalOutcome, runRemoval } from './removal-plan.ts';
import { formatRemovalOutcome, removalOutcomeToJson } from './removal-render.ts';

describe('formatRemovalOutcome', () => {
  test.each([
    ['removed', '·', ''],
    ['skipped', '·', 'Left in place: '],
    ['failed', '✗', ''],
  ] as const)('keeps multiline %s details under their own items', (status, bullet, prefix) => {
    const results = ['Alpha', 'Beta'].map((label) => ({
      op: { kind: 'remove-path' as const, group: label, label, path: `/${label}` },
      status,
      detail: `${label} first line\n${label} second line`,
    }));
    const outcome: RemovalOutcome = {
      results,
      removed: status === 'removed' ? results : [],
      failed: status === 'failed' ? results : [],
    };

    expect(stripVTControlCharacters(formatRemovalOutcome(outcome))).toContain(
      `  ${bullet} ${prefix}Alpha — Alpha first line\n      Alpha second line\n  ${bullet} ${prefix}Beta — Beta first line\n      Beta second line`,
    );
    const json = removalOutcomeToJson('uninstall', outcome);
    expect(json.mode === 'applied' && json[status].map((item) => item.detail)).toEqual([
      'Alpha first line\nAlpha second line',
      'Beta first line\nBeta second line',
    ]);
    expect(results.map((item) => item.detail)).toEqual([
      'Alpha first line\nAlpha second line',
      'Beta first line\nBeta second line',
    ]);
  });

  test('groups real retained Pi records and recovery guidance beneath each project failure', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ok-removal-render-')));
    try {
      const home = join(base, 'home');
      mkdirSync(home);
      const ops: RemovalOp[] = [];
      const snapshots: Array<{ path: string; bytes: string }> = [];
      const records = ['project-alpha', 'project-beta'].map((name) => {
        const cwd = join(base, name);
        mkdirSync(cwd);
        const store = join(base, `${name}-trust.json`);
        writeFileSync(store, `${JSON.stringify({ [cwd]: true, unrelated: false })}\n`);
        const receipt = commitPiTrustGrant(
          home,
          preparePiTrustGrant(home, cwd, store, store, { present: true, value: false }),
        );
        for (const path of [store, receipt.path]) {
          snapshots.push({ path, bytes: readFileSync(path, 'utf8') });
        }
        renameSync(cwd, `${cwd}-moved`);
        ops.push(
          ...deinitOps(cwd, home, name).filter(
            (op) => op.kind === 'stop-server' || (op.kind === 'mcp-entry' && op.editorId === 'pi'),
          ),
        );
        return receipt;
      });

      const outcome = await runRemoval({ scope: 'uninstall', ops });
      expect(outcome.failed).toHaveLength(2);
      const rendered = stripVTControlCharacters(formatRemovalOutcome(outcome));
      const blocks = rendered.split('\n  ✗ ').slice(1);
      expect(blocks).toHaveLength(2);
      for (const [index, receipt] of records.entries()) {
        const block = blocks[index];
        expect(block).toContain('Pi trust cleanup failed (kept-unverified):\n      ');
        expect(block).toContain('current trust decisions were not checked:');
        expect(block).toContain(
          `\n      key ${escapeDisplayPath(JSON.stringify(receipt.record.cwd))}; configured store ${escapeDisplayPath(JSON.stringify(receipt.record.configuredTrustPath))}; recorded destination ${escapeDisplayPath(JSON.stringify(receipt.record.canonicalTrustPath))}; ownership record ${escapeDisplayPath(JSON.stringify(receipt.path))} (committed)\n      `,
        );
        expect(block).toContain('restore the recorded previous value');
        expect(block).toContain('remove that key only when no previous entry was recorded');
        expect(block).toContain(
          'parent-folder and global trust settings still apply.\n      Trust cleanup remains incomplete so cleanup can be retried.',
        );
        expect(
          block
            ?.split('\n')
            .slice(1)
            .every((line) => line.startsWith('      ')),
        ).toBe(true);
        for (const other of records) {
          if (other !== receipt) expect(block).not.toContain(other.record.cwd);
        }
      }
      const json = removalOutcomeToJson('uninstall', outcome);
      expect(json.mode === 'applied' && json.failed.map((item) => item.detail)).toEqual(
        outcome.failed.map((item) => item.detail),
      );
      for (const { path, bytes } of snapshots) expect(readFileSync(path, 'utf8')).toBe(bytes);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
