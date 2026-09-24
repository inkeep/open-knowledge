import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  candidateIdentity,
  downloadCandidateDmg,
  selectDmgAsset,
} from './download-candidate-dmg.mjs';

test.skipIf(process.platform === 'win32')(
  'the macOS CLI transport projects an oversized GitHub comparison before buffering it',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-candidate-cli-'));
    try {
      writeFileSync(
        join(dir, 'gh'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'api') {
  const response = { status: 'ahead', files: [{ patch: 'x'.repeat(2 * 1024 * 1024) }] };
  const jq = args.indexOf('--jq');
  process.stdout.write(JSON.stringify(jq >= 0 && args[jq + 1] === '{status}' ? { status: response.status } : response));
} else if (args[1] === 'view') {
  process.stdout.write(JSON.stringify({ assets: [{ name: 'OpenKnowledge-Beta-arm64.dmg' }] }));
} else if (args[1] === 'download') {
  fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], args[args.indexOf('--pattern') + 1]), 'fixture DMG');
} else { process.exit(2); }
`,
        { mode: 0o755 },
      );
      const output = join(dir, 'output');
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./download-candidate-dmg.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH}`,
            CANDIDATE: 'v0.78.0-beta.5',
            RUNNER_TEMP: dir,
            GITHUB_OUTPUT: output,
          },
          stdio: 'pipe',
        },
      );
      const path = readFileSync(output, 'utf8').trim().slice('dmg_path='.length);
      expect(readFileSync(path, 'utf8')).toBe('fixture DMG');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each([
  { candidate: 'v0.77.9-beta.0', status: 'behind', name: 'OpenKnowledge-arm64.dmg' },
  { candidate: 'v0.78.0-beta.5', status: 'ahead', name: 'OpenKnowledge-Beta-arm64.dmg' },
])(
  'the download boundary composes GitHub ancestry and inventory for $candidate',
  ({ candidate, status, name }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-candidate-download-'));
    try {
      const path = downloadCandidateDmg({
        candidate,
        dir,
        gh: (args) => {
          if (args[0] === 'api') {
            expect(args).toEqual([
              'api',
              `repos/{owner}/{repo}/compare/15cd5fd9c2644d9af05609d501a5f068a1da106c...${candidate}?per_page=1`,
              '--jq',
              '{status}',
            ]);
            return JSON.stringify({ status });
          }
          if (args[1] === 'view') {
            expect(args).toEqual(['release', 'view', candidate, '--json', 'assets']);
            return JSON.stringify({ assets: [{ name }] });
          }
          expect(args).toEqual(['release', 'download', candidate, '--pattern', name, '--dir', dir]);
          writeFileSync(join(dir, name), 'downloaded inventory fixture');
          return '';
        },
      });
      expect(readFileSync(path, 'utf8')).toBe('downloaded inventory fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

describe('candidate DMG inventory', () => {
  test.each([
    { name: 'OpenKnowledge-arm64.dmg', identity: 'legacy' },
    { name: 'OpenKnowledge-Beta-arm64.dmg', identity: 'beta' },
  ])('accepts $name only for its historical product identity $identity', ({ name, identity }) => {
    expect(selectDmgAsset([{ name }, { name: `${name}.blockmap` }], identity)).toBe(name);
  });

  test.each(
    [
      [],
      [{ name: 'unrelated.dmg' }],
      [{ name: '../OpenKnowledge-arm64.dmg' }],
      [{ name: 'OpenKnowledge-arm64.dmg' }, { name: 'OpenKnowledge-Beta-arm64.dmg' }],
    ].map((assets) => ({ assets })),
  )('refuses missing, unknown or ambiguous installers: $assets', ({ assets }) => {
    expect(selectDmgAsset(assets, 'legacy')).toBeNull();
    expect(selectDmgAsset(assets, 'beta')).toBeNull();
  });

  test('never accepts a Stable artifact for a split-identity Beta tag', () => {
    expect(selectDmgAsset([{ name: 'OpenKnowledge-arm64.dmg' }], 'beta')).toBeNull();
    expect(selectDmgAsset([{ name: 'OpenKnowledge-Beta-arm64.dmg' }], 'legacy')).toBeNull();
    expect(selectDmgAsset([{ name: 'OpenKnowledge-arm64.dmg' }], 'unknown')).toBeNull();
  });

  test('requires proven ancestry across the product-identity split', () => {
    expect(candidateIdentity('behind')).toBe('legacy');
    expect(candidateIdentity('ahead')).toBe('beta');
    expect(candidateIdentity('identical')).toBe('beta');
    expect(() => candidateIdentity('diverged')).toThrow('Cannot establish');
    expect(() => candidateIdentity(undefined)).toThrow('Cannot establish');
  });
});
