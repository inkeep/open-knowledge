import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');
const tsdownConfig = resolve(desktopRoot, '..', 'cli', 'tsdown.config.ts');
const okRoot = resolve(desktopRoot, '..', '..');

const KNOWN_UNCOVERED: Record<string, string> = {
  yjs: 'library-entry-only external; cli.mjs inlines yjs and is the only entry resources/cli runs',
};

function shippedViaParcelStaging(pkg: string): boolean {
  if (pkg !== '@parcel/watcher') return false;
  return readExtraResources().some(
    (r) => r.to === 'cli/node_modules' && r.from === 'build/parcel-watcher-staging/node_modules',
  );
}

const EXPECTED_NEVER_BUNDLE = [
  '@parcel/watcher',
  '@napi-rs/keyring',
  '@inkeep/open-knowledge-native-config',
] as const;

function readNeverBundle(): string[] {
  if (!existsSync(tsdownConfig)) {
    throw new Error(
      `tsdown config not found at ${tsdownConfig}. This guard reads its \`neverBundle\` ` +
        `array; if the config moved, update this path rather than letting the guard go quiet.`,
    );
  }
  const src = readFileSync(tsdownConfig, 'utf8');
  const constMatch = /const nativeAddonNeverBundle\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!constMatch) {
    throw new Error(
      `could not locate the \`nativeAddonNeverBundle = [...]\` array literal in ${tsdownConfig}. ` +
        `If the externals list moved or is now computed, this guard needs a real parser — ` +
        `it must not silently fall back to an empty list.`,
    );
  }
  const quoted = (block: string): string[] =>
    [...block.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1] as string);
  const entries = new Set(quoted(constMatch[1] as string));
  for (const m of src.matchAll(/neverBundle:\s*\[([^\]]*)\]/g)) {
    for (const name of quoted(m[1] as string)) entries.add(name);
  }
  if (entries.size === 0) {
    throw new Error(`matched \`neverBundle\` in ${tsdownConfig} but extracted no package names.`);
  }
  return [...entries];
}

function readExtraResourceTargets(platform?: 'mac' | 'win' | 'linux'): string[] {
  return readExtraResources(platform)
    .map((r) => r.to ?? '')
    .filter(Boolean);
}

type ExtraResourceRule = { from?: string; to?: string; filter?: string[] | string };

type BuilderConfig = {
  extraResources?: ExtraResourceRule[];
  mac?: { extraResources?: ExtraResourceRule[] };
  win?: { extraResources?: ExtraResourceRule[] };
  linux?: { extraResources?: ExtraResourceRule[] };
};

function readExtraResources(platform?: 'mac' | 'win' | 'linux'): ExtraResourceRule[] {
  try {
    const cfg = parse(readFileSync(builderYml, 'utf8')) as BuilderConfig;
    const top = cfg.extraResources ?? [];
    if (!platform) {
      return [
        ...top,
        ...(cfg.mac?.extraResources ?? []),
        ...(cfg.win?.extraResources ?? []),
        ...(cfg.linux?.extraResources ?? []),
      ];
    }
    return [...top, ...(cfg[platform]?.extraResources ?? [])];
  } catch {
    return [];
  }
}

function readAsarUnpack(): string[] {
  try {
    const cfg = parse(readFileSync(builderYml, 'utf8')) as { asarUnpack?: string[] };
    return cfg.asarUnpack ?? [];
  } catch {
    return [];
  }
}

function asFilterList(filter: string[] | string | undefined): string[] {
  if (Array.isArray(filter)) return filter;
  return filter ? [filter] : [];
}

describe('bundled CLI can resolve tsdown neverBundle native addons', () => {
  const neverBundle = readNeverBundle();
  const targets = readExtraResourceTargets();

  test('neverBundle list + electron-builder.yml parsed (premise check)', () => {
    expect(existsSync(builderYml)).toBe(true);
    expect(existsSync(tsdownConfig)).toBe(true);
    expect(neverBundle).toEqual(expect.arrayContaining([...EXPECTED_NEVER_BUNDLE]));
  });

  for (const pkg of neverBundle) {
    test(`'${pkg}' is shipped to cli/node_modules or explicitly allowlisted`, () => {
      const shipped = targets.includes(`cli/node_modules/${pkg}`) || shippedViaParcelStaging(pkg);
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

  test("'@napi-rs/keyring' ships the wrapper AND a platform binary on every platform", () => {
    expect(targets).toContain('cli/node_modules/@napi-rs/keyring');
    const expectedPerPlatform: Record<'mac' | 'win' | 'linux', string[]> = {
      mac: ['keyring-darwin-arm64'],
      win: ['keyring-win32-x64-msvc', 'keyring-win32-arm64-msvc'],
      linux: ['keyring-linux-x64-gnu', 'keyring-linux-arm64-gnu'],
    };
    for (const [platform, pkgs] of Object.entries(expectedPerPlatform)) {
      const platformTargets = readExtraResourceTargets(platform as 'mac' | 'win' | 'linux');
      for (const pkg of pkgs) {
        expect(
          platformTargets,
          `Ship '@napi-rs/${pkg}' into cli/node_modules for ${platform} — the wrapper ` +
            'requires its platform binary sibling at runtime.',
        ).toContain(`cli/node_modules/@napi-rs/${pkg}`);
      }
    }
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

describe('per-platform ok CLI wrapper ships to cli/bin', () => {
  test('mac + linux ship a cli/bin/ok.sh; win ships ok.cmd + ok.ps1', () => {
    expect(readExtraResourceTargets('mac')).toContain('cli/bin/ok.sh');
    expect(readExtraResourceTargets('linux')).toContain('cli/bin/ok.sh');
    const win = readExtraResourceTargets('win');
    expect(win).toContain('cli/bin/ok.cmd');
    expect(win).toContain('cli/bin/ok.ps1');
  });

  test('the linux cli/bin/ok.sh sources the linux-layout wrapper, not the .app one', () => {
    const rule = readExtraResources('linux').find((r) => r.to === 'cli/bin/ok.sh');
    expect(
      rule?.from,
      'linux must ship resources/cli/bin/ok-linux.sh as cli/bin/ok.sh — the darwin ' +
        'ok.sh derives its paths from the .app bundle shape and self-diagnoses exit 69 ' +
        'on the flat Linux layout.',
    ).toBe('resources/cli/bin/ok-linux.sh');
  });
});

describe('@inkeep/open-knowledge-native-config ships its napi loader + platform binary', () => {
  const NATIVE_CONFIG = '@inkeep/open-knowledge-native-config';
  const nativeConfigDir = resolve(desktopRoot, '..', 'native-config');

  test('an extraResources rule copies the addon into cli/node_modules shipping loader AND binary', () => {
    const rule = readExtraResources().find((r) => r.to === `cli/node_modules/${NATIVE_CONFIG}`);
    expect(
      rule,
      `electron-builder.yml has no extraResources rule copying ${NATIVE_CONFIG} into ` +
        'cli/node_modules. The bundled CLI cannot resolve the toml_edit addon from ' +
        'cli/dist/ → the Codex TOML write degrades to a non-destructive decline.',
    ).toBeDefined();
    const filter = asFilterList(rule?.filter);
    expect(filter).toContain('index.js');
    expect(
      filter.includes('*.node'),
      `The ${NATIVE_CONFIG} extraResources filter must include '*.node' — without the ` +
        "platform binary the loader is shipped but require('./<binary>.node') throws.",
    ).toBe(true);
  });

  test('asarUnpack unpacks the addon for the in-process desktop main consumer', () => {
    expect(readAsarUnpack()).toContain(`**/${NATIVE_CONFIG}/**`);
  });

  test('the addon source dir exists at the extraResources `from` path', () => {
    expect(existsSync(nativeConfigDir)).toBe(true);
    expect(existsSync(resolve(nativeConfigDir, 'package.json'))).toBe(true);
  });

  test('the napi-built loader + a platform binary exist after a build', () => {
    const loader = resolve(nativeConfigDir, 'index.js');
    const nodeBinaries = existsSync(nativeConfigDir)
      ? readdirSync(nativeConfigDir).filter((f) => f.endsWith('.node'))
      : [];
    if (!existsSync(loader) || nodeBinaries.length === 0) {
      console.warn(
        `[electron-builder-cli-native-deps] SKIP: ${NATIVE_CONFIG} not built ` +
          `(no index.js / *.node in ${nativeConfigDir}). Run \`pnpm run build\` first; ` +
          'the gate builds it upstream of this tier.',
      );
      return;
    }
    expect(nodeBinaries.length).toBeGreaterThan(0);
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(nodeBinaries).toContain('native-config.darwin-arm64.node');
    }
  });
});

describe('@inkeep/open-knowledge-native-config ships bundled in cli/dist/native', () => {
  const cliDist = resolve(desktopRoot, '..', 'cli', 'dist');

  test('the cli/dist extraResources rule does not filter out the native bundle', () => {
    const rule = readExtraResources().find((r) => r.to === 'cli/dist');
    expect(
      rule,
      'electron-builder.yml must copy ../cli/dist into the packaged app so the ' +
        'bundled native-config (cli/dist/native) reaches the spawned CLI subprocess.',
    ).toBeDefined();
    const filter = asFilterList(rule?.filter);
    expect(filter).toContain('**/*');
    for (const excluded of ['!**/*.node', '!**/*.js', '!**/package.json', '!**/native/**']) {
      expect(
        filter.includes(excluded),
        `the cli/dist filter must not exclude '${excluded}' — it would strip the bundled addon.`,
      ).toBe(false);
    }
  });

  test('the bundled loader + platform binary exist in cli/dist/native after a build', () => {
    const nativeBundle = resolve(cliDist, 'native');
    const loader = resolve(nativeBundle, 'index.js');
    const pkgJson = resolve(nativeBundle, 'package.json');
    const nodeBinaries = existsSync(nativeBundle)
      ? readdirSync(nativeBundle).filter((f) => f.endsWith('.node'))
      : [];
    if (!existsSync(loader) || nodeBinaries.length === 0) {
      console.warn(
        '[electron-builder-cli-native-deps] SKIP: cli/dist/native not built ' +
          `(no index.js / *.node in ${nativeBundle}). Run \`pnpm run build\` first.`,
      );
      return;
    }
    expect(existsSync(pkgJson)).toBe(true);
    expect(nodeBinaries.length).toBeGreaterThan(0);
  });
});
