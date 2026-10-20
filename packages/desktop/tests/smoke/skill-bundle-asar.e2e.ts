import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import electron from 'electron';

test('PRD-9697: installs and replaces a bundled skill from a real ASAR', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-skill-asar-'));
  try {
    const skill = Buffer.from('---\nname: open-knowledge\n---\nBundled skill\n');
    const asset = Buffer.from([0, 255, 13, 10, 128]);
    const json = Buffer.from(
      JSON.stringify({
        files: {
          project: {
            files: {
              'SKILL.md': { size: skill.length, offset: '0' },
              references: {
                files: { 'asset.bin': { size: asset.length, offset: String(skill.length) } },
              },
            },
          },
        },
      }),
    );
    const headerSize = Math.ceil((json.length + 4) / 4) * 4;
    const header = Buffer.alloc(12 + headerSize);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(headerSize + 4, 4);
    header.writeUInt32LE(headerSize, 8);
    header.writeUInt32LE(json.length, 12);
    json.copy(header, 16);
    writeFileSync(join(root, 'app.asar'), Buffer.concat([header, skill, asset]));
    const source = readFileSync(
      new URL('../../../cli/src/integrations/replace-bundle-dir.ts', import.meta.url),
      'utf8',
    );
    writeFileSync(join(root, 'copy.mjs'), stripTypeScriptTypes(source));
    writeFileSync(
      join(root, 'main.cjs'),
      `
      const { app } = require('electron');
      const fs = require('node:fs');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      const fixtureRoot = path.dirname(process.argv[1]);
      (async () => {
        const { replaceBundleDir } = await import('./copy.mjs');
        const source = path.join(fixtureRoot, 'app.asar', 'project');
        assert.deepEqual(fs.readFileSync(path.join(source, 'SKILL.md')), Buffer.from(${JSON.stringify([...skill])}));
        const target = path.join(fixtureRoot, 'project', '.pi', 'skills', 'open-knowledge', 'SKILL.md');
        assert.equal(replaceBundleDir(source, target), 'written');
        fs.writeFileSync(path.join(path.dirname(target), 'stale.txt'), 'old');
        assert.equal(replaceBundleDir(source, target), 'overwritten');
        assert.equal(fs.existsSync(path.join(path.dirname(target), 'stale.txt')), false);
        assert.deepEqual(fs.readFileSync(target), Buffer.from(${JSON.stringify([...skill])}));
        assert.deepEqual(fs.readFileSync(path.join(path.dirname(target), 'references', 'asset.bin')), Buffer.from(${JSON.stringify([...asset])}));
        app.exit(0);
      })().catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
    `,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(String(electron), [join(root, 'main.cjs')], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
