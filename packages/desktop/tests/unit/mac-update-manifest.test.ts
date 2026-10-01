import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  MAC_UPDATE_MINIMUM_DARWIN_VERSION,
  stampMacUpdateManifests,
  withMacMinimumSystemVersion,
} from '../../scripts/mac-update-manifest.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper';

const MANIFEST = `version: 0.72.0-beta.1
files:
  - url: OpenKnowledge-Beta-arm64.zip
    sha512: abc
    size: 10
path: OpenKnowledge-Beta-arm64.zip
sha512: abc
releaseDate: '2026-10-01T00:00:00.000Z'`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDirBestEffort(dir);
});

describe('withMacMinimumSystemVersion', () => {
  test('requires Darwin 22, the macOS 13 kernel, as a string electron-updater can compare', () => {
    const stamped = withMacMinimumSystemVersion(MANIFEST);
    expect(MAC_UPDATE_MINIMUM_DARWIN_VERSION).toBe('22.0.0');
    expect(parseYaml(stamped)).toEqual({
      ...parseYaml(MANIFEST),
      minimumSystemVersion: '22.0.0',
    });
    expect(stamped.startsWith(MANIFEST)).toBe(true);
  });

  test('leaves an already stamped manifest unchanged and refuses a different floor', () => {
    const stamped = withMacMinimumSystemVersion(MANIFEST);
    expect(withMacMinimumSystemVersion(stamped)).toBe(stamped);
    expect(() => withMacMinimumSystemVersion(stamped, '23.0.0')).toThrow(/already requires 22.0.0/);
  });

  test('refuses a manifest that is not a mapping', () => {
    expect(() => withMacMinimumSystemVersion('- a\n- b\n')).toThrow(/not a YAML mapping/);
  });
});

describe('stampMacUpdateManifests', () => {
  test('stamps every macOS manifest and leaves other platforms alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-mac-manifest-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'beta-mac.yml'), MANIFEST);
    writeFileSync(join(dir, 'beta-product-mac.yml'), MANIFEST);
    writeFileSync(join(dir, 'beta.yml'), MANIFEST);
    expect(stampMacUpdateManifests(dir).sort()).toEqual(['beta-mac.yml', 'beta-product-mac.yml']);
    for (const name of ['beta-mac.yml', 'beta-product-mac.yml']) {
      expect(parseYaml(readFileSync(join(dir, name), 'utf8')).minimumSystemVersion).toBe('22.0.0');
    }
    expect(readFileSync(join(dir, 'beta.yml'), 'utf8')).toBe(MANIFEST);
  });

  test('names the manifest that could not be stamped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-mac-manifest-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'beta-mac.yml'), '- not\n- a mapping\n');
    expect(() => stampMacUpdateManifests(dir)).toThrow(/^beta-mac\.yml: .*not a YAML mapping/);
  });

  test('fails when the build produced no macOS manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-mac-manifest-'));
    dirs.push(dir);
    expect(() => stampMacUpdateManifests(dir)).toThrow(/wrote no macOS update manifest/);
    expect(() => stampMacUpdateManifests(join(dir, 'missing'))).toThrow(
      /wrote no macOS update manifest/,
    );
  });
});
