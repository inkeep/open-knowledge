import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';


const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');
const tsdownConfig = resolve(desktopRoot, '..', 'cli', 'tsdown.config.ts');
const okRoot = resolve(desktopRoot, '..', '..');

const KNOWN_UNCOVERED: Record<string, string> = {
  '@parcel/watcher': 'degrades to chokidar fallback; transitive runtime deps tracked as follow-up',
};

function readNeverBundle(): string[] {
  try {
    const src = readFileSync(tsdownConfig, 'utf8');
    const m = /neverBundle:\s*\[([^\]]*)\]/.exec(src);
    if (!m) return [];
    return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1] as string);
  } catch {
    return [];
  }
}

function readExtraResourceTargets(): string[] {
  try {
    const cfg = parse(readFileSync(builderYml, 'utf8')) as {
      extraResources?: Array<{ to?: string }>;
    };
    return (cfg.extraResources ?? []).map((r) => r.to ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

describe('bundled CLI can resolve tsdown neverBundle native addons', () => {
  const neverBundle = readNeverBundle();
  const targets = readExtraResourceTargets();

  test('neverBundle list + electron-builder.yml parsed (premise check)', () => {
    expect(existsSync(builderYml)).toBe(true);
    expect(existsSync(tsdownConfig)).toBe(true);
    expect(neverBundle.length).toBeGreaterThan(0);
  });

  for (const pkg of neverBundle) {
    test(`'${pkg}' is shipped to cli/node_modules or explicitly allowlisted`, () => {
      const shipped = targets.includes(`cli/node_modules/${pkg}`);
      const allowlisted = pkg in KNOWN_UNCOVERED;
      expect(
        shipped || allowlisted,
        `tsdown keeps '${pkg}' external (neverBundle) but electron-builder.yml ships ` +
          `no 'cli/node_modules/${pkg}' copy rule. The bundled CLI cannot resolve it ` +
          `from cli/dist/ → ERR_MODULE_NOT_FOUND. Add an extraResources rule copying ` +
          `it (and its platform binary) into cli/node_modules/, or add it to ` +
          `KNOWN_UNCOVERED with a rationale.`,
      ).toBe(true);
    });
  }

  test("'@napi-rs/keyring' ships the wrapper AND an arm64 platform binary", () => {
    expect(targets).toContain('cli/node_modules/@napi-rs/keyring');
    const hasPlatform = targets.some((t) => t === 'cli/node_modules/@napi-rs/keyring-darwin-arm64');
    expect(
      hasPlatform,
      "Ship '@napi-rs/keyring-darwin-arm64' into cli/node_modules — the wrapper " +
        'requires its platform binary sibling at runtime.',
    ).toBe(true);
  });

  test('keyring copy sources exist at the hoisted root node_modules', () => {
    expect(existsSync(resolve(okRoot, 'node_modules', '@napi-rs', 'keyring'))).toBe(true);
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(existsSync(resolve(okRoot, 'node_modules', '@napi-rs', 'keyring-darwin-arm64'))).toBe(
        true,
      );
    }
  });
});
