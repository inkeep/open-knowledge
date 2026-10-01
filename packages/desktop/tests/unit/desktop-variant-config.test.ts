import { type ChildProcess, spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  betaBuildVersion,
  createLocalEntitlements,
  createVariantBuilderConfig,
  createVariantHelperInfo,
  createVariantNsisInclude,
  createVariantPostInstall,
  createVariantPostRemove,
  parseBuilderConfig,
} from '../../scripts/desktop-variant-config.ts';
import { MAC_UPDATE_MINIMUM_DARWIN_VERSION } from '../../scripts/mac-update-manifest.ts';
import { DESKTOP_VARIANTS } from '../../src/shared/desktop-variant.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MAC_MANIFEST = `version: 1.0.0
files:
  - url: OpenKnowledge-arm64.zip
    sha512: abc
    size: 1
path: OpenKnowledge-arm64.zip
sha512: abc
releaseDate: '2026-10-01T00:00:00.000Z'
`;

const fixtures: string[] = [];
const children = new Map<ChildProcess, Promise<void>>();

afterEach(async () => {
  for (const [child, closed] of children) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
      child.kill();
    await closed;
  }
  children.clear();
  for (const fixture of fixtures.splice(0)) removeTempDirBestEffort(fixture);
});

async function runBuilder(
  args: string[],
  status = 0,
  signal = false,
  platform: NodeJS.Platform = process.platform,
  variant = 'stable',
  writesMacManifest = true,
) {
  const fixture = mkdtempSync(join(tmpdir(), 'ok-builder-wrapper-'));
  fixtures.push(fixture);
  for (const file of [
    'scripts/run-electron-builder.mjs',
    'scripts/desktop-variant-config.ts',
    'scripts/mac-update-manifest.ts',
    'scripts/packaging-diagnostics.mjs',
    'src/shared/desktop-variant.ts',
    'package.json',
    'electron-builder.yml',
    'build/installer.nsh',
    'build/deb-postinst.sh',
    'build/deb-postrm.sh',
    'build/entitlements.mac.plist',
    'build/helper-bundle/Info.plist',
  ]) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(desktopRoot, file), target);
  }
  for (const dep of ['yaml', '@inkeep/open-knowledge-core']) {
    const target = join(fixture, 'node_modules', dep);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(join(desktopRoot, 'node_modules', dep)), target, 'junction');
  }
  const builderDir = join(fixture, 'node_modules/electron-builder');
  mkdirSync(builderDir, { recursive: true });
  writeFileSync(
    join(builderDir, 'package.json'),
    JSON.stringify({ name: 'electron-builder', type: 'module' }),
  );
  writeFileSync(
    join(builderDir, 'cli.js'),
    `
    import { mkdirSync, writeFileSync } from 'node:fs';
    if (process.argv.includes('--mac') && process.env.OK_BUILDER_TEST_MAC_MANIFEST === '1') {
      mkdirSync('dist-desktop', { recursive: true });
      writeFileSync('dist-desktop/latest-mac.yml', ${JSON.stringify(MAC_MANIFEST)});
    }
    writeFileSync('invocation.json', JSON.stringify({
      execPath: process.execPath,
      args: process.argv.slice(2),
      entry: process.argv[1],
      cwd: process.cwd(),
      marker: process.env.OK_BUILDER_TEST_MARKER,
    }));
    process.exit(Number(process.env.OK_BUILDER_TEST_STATUS));
  `,
  );
  const preload = join(fixture, 'platform.mjs');
  writeFileSync(
    preload,
    `
    import childProcess from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: process.env.OK_BUILDER_TEST_PLATFORM });
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      writeFileSync('spawn.json', JSON.stringify({ command, args, shell: options?.shell ?? false, platform: process.platform }));
      return process.env.OK_BUILDER_TEST_SIGNAL === '1'
        ? { status: null, signal: 'SIGTERM' }
        : spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `,
  );
  const child = spawn(
    process.execPath,
    ['--import', preload, join(fixture, 'scripts/run-electron-builder.mjs'), ...args],
    {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: '',
        CSC_LINK: '',
        CSC_KEYCHAIN: '',
        OK_DESKTOP_VARIANT: variant,
        OK_BUILDER_TEST_MARKER: 'forwarded',
        OK_BUILDER_TEST_STATUS: String(status),
        OK_BUILDER_TEST_SIGNAL: signal ? '1' : '0',
        OK_BUILDER_TEST_PLATFORM: platform,
        OK_BUILDER_TEST_MAC_MANIFEST: writesMacManifest ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.set(child, new Promise<void>((resolve) => child.once('close', () => resolve())));
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const result = await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stderr }));
  });
  return { fixture: realpathSync(fixture), result };
}

const configSource = `
appId: com.inkeep.open-knowledge
productName: OpenKnowledge
protocols:
  - name: OpenKnowledge URL
    schemes: [openknowledge]
publish:
  - provider: github
    owner: inkeep
    repo: open-knowledge
    channel: latest
mac:
  icon: build/okglass.icon
  entitlements: build/entitlements.mac.plist
  provisioningProfile: build/embedded.provisionprofile
  extraResources: []
  extraFiles: []
  extendInfo: {}
win:
  icon: build/icon.png
  extraResources:
    - from: resources/cli/bin/ok.cmd
      to: cli/bin/ok.cmd
    - from: resources/cli/bin/ok.ps1
      to: cli/bin/ok.ps1
dmg:
  artifactName: \${productName}-\${arch}.\${ext}
linux:
  icon: build/icon.png
  artifactName: \${productName}-\${arch}.\${ext}
  executableName: openknowledge
  extraResources: []
nsis:
  artifactName: \${productName}-Setup-\${arch}.\${ext}
  include: build/installer.nsh
deb:
  afterInstall: build/deb-postinst.sh
  afterRemove: build/deb-postrm.sh
rpm:
  afterInstall: build/deb-postinst.sh
  afterRemove: build/deb-postrm.sh
  depends: [libsecret]
`;

const paths = {
  includePath: '.variant-build/installer.nsh',
  postInstallPath: '.variant-build/deb-postinst.sh',
  postRemovePath: '.variant-build/deb-postrm.sh',
  localEntitlementsPath: '.variant-build/entitlements.mac.local.plist',
  helperInfoPath: '.variant-build/helper-Info.plist',
  profileAvailable: false,
};

const token = (name: string): string => `\${${name}}`;
const macArtifact = (name: string): string =>
  `${name}-${token('version')}-${token('arch')}-mac.${token('ext')}`;
const platformArtifact = (name: string): string => `${name}-${token('arch')}.${token('ext')}`;
const nsisArtifact = (name: string): string => `${name}-Setup-${token('arch')}.${token('ext')}`;

describe('desktop variant builder config', () => {
  test('legacy Beta preserves the installed identity, CLI wrappers and old manifest names', () => {
    const stable = createVariantBuilderConfig(
      parseBuilderConfig(configSource),
      'stable',
      paths,
      '0.78.0-beta.6',
    );
    const legacy = createVariantBuilderConfig(
      parseBuilderConfig(configSource),
      'legacy-beta',
      paths,
      '0.78.0-beta.6',
    );
    expect(legacy).toEqual({
      ...stable,
      extraMetadata: {
        ...stable.extraMetadata,
        okDesktopVariant: 'legacy-beta',
        version: '0.78.0-beta.6',
      },
      publish: stable.publish.map((entry) => ({ ...entry, channel: 'beta' })),
    });
  });

  test('preserves Stable identity', () => {
    const config = createVariantBuilderConfig(
      parseBuilderConfig(configSource),
      'stable',
      paths,
      '0.77.7',
    );
    expect(config).toMatchObject({
      appId: 'com.inkeep.open-knowledge',
      productName: 'OpenKnowledge',
      protocols: [{ schemes: ['openknowledge'] }],
      publish: [{ channel: 'latest' }],
      mac: {
        icon: 'build/okglass.icon',
        artifactName: macArtifact('OpenKnowledge'),
        provisioningProfile: 'build/embedded.provisionprofile',
      },
      dmg: { artifactName: platformArtifact('OpenKnowledge') },
      nsis: { artifactName: nsisArtifact('OpenKnowledge') },
      linux: {
        artifactName: platformArtifact('OpenKnowledge'),
        executableName: 'openknowledge',
      },
      deb: {
        afterInstall: paths.postInstallPath,
        afterRemove: paths.postRemovePath,
        packageName: 'openknowledge',
      },
      rpm: {
        afterInstall: paths.postInstallPath,
        afterRemove: paths.postRemovePath,
        packageName: 'OpenKnowledge',
        depends: ['libsecret'],
      },
    });
    expect(config.win.extraResources).toEqual([
      { from: 'resources/cli/bin/ok.cmd', to: 'cli/bin/ok.cmd' },
      { from: 'resources/cli/bin/ok.ps1', to: 'cli/bin/ok.ps1' },
    ]);
  });

  test('builds isolated Beta config', () => {
    const beta = createVariantBuilderConfig(
      parseBuilderConfig(configSource),
      'beta',
      paths,
      '0.77.7',
    );
    expect(beta).toMatchObject({
      appId: 'com.inkeep.open-knowledge.beta',
      productName: 'OpenKnowledge Beta',
      protocols: [{ schemes: ['openknowledge-beta'] }],
      publish: [{ channel: 'beta-product' }],
      extraMetadata: {
        name: 'openknowledge-beta-desktop',
        productName: 'OpenKnowledge Beta',
        version: '0.77.7-beta.0',
      },
      mac: {
        icon: 'build/icon-beta.png',
        artifactName: macArtifact('OpenKnowledge-Beta'),
        entitlements: paths.localEntitlementsPath,
      },
      dmg: { artifactName: platformArtifact('OpenKnowledge-Beta') },
      nsis: { artifactName: nsisArtifact('OpenKnowledge-Beta') },
      linux: {
        artifactName: platformArtifact('OpenKnowledge-Beta'),
        executableName: 'openknowledge-beta',
      },
      deb: {
        afterInstall: paths.postInstallPath,
        afterRemove: paths.postRemovePath,
        packageName: 'openknowledge-beta-desktop',
      },
      rpm: {
        afterInstall: paths.postInstallPath,
        afterRemove: paths.postRemovePath,
        packageName: 'openknowledge-beta-desktop',
        depends: ['libsecret'],
      },
    });
    expect(beta.mac.provisioningProfile).toBeUndefined();
    expect(beta.win.extraResources.map((entry) => entry.to)).toEqual([
      'cli/bin/ok-beta.cmd',
      'cli/bin/ok-beta.ps1',
      'cli/bin/open-knowledge-beta.cmd',
      'cli/bin/open-knowledge-beta.ps1',
    ]);
  });

  test('selects the matching signed profile when it is available', () => {
    const beta = createVariantBuilderConfig(
      parseBuilderConfig(configSource),
      'beta',
      {
        ...paths,
        profileAvailable: true,
      },
      '0.77.7-beta.4',
    );
    expect(beta.mac.provisioningProfile).toBe('build/embedded.beta.provisionprofile');
    expect(beta.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(beta.extraMetadata?.version).toBe('0.77.7-beta.4');
  });

  test('derives a valid manual Beta version from the package version', () => {
    expect(betaBuildVersion('0.77.7')).toBe('0.77.7-beta.0');
    expect(betaBuildVersion('0.77.7-beta.4')).toBe('0.77.7-beta.4');
    expect(() => betaBuildVersion('dev')).toThrow(/invalid/);
  });

  test('names platform integration shims per variant', () => {
    expect(
      createVariantNsisInclude(
        'openknowledge:// Software\\Classes\\openknowledge URL:OpenKnowledge',
        'beta',
      ),
    ).toBe('openknowledge-beta:// Software\\Classes\\openknowledge-beta URL:OpenKnowledge Beta');
    expect(
      createVariantPostInstall(
        'ln -sf "$OK_WRAPPER" /usr/bin/ok\nln -sf "$OK_WRAPPER" /usr/bin/open-knowledge',
        'beta',
      ),
    ).toContain(
      'ln -sf "$OK_WRAPPER" /usr/bin/ok-beta\nln -sf "$OK_WRAPPER" /usr/bin/open-knowledge-beta',
    );
    expect(
      createVariantPostRemove('for link in /usr/bin/ok /usr/bin/open-knowledge; do', 'beta'),
    ).toContain('/usr/bin/ok-beta /usr/bin/open-knowledge-beta');
  });

  test('drops the restricted entitlement for unsigned local variant builds', () => {
    expect(
      createLocalEntitlements(
        '<dict>\n<key>com.apple.developer.associated-domains</key><array><string>x</string></array>\n</dict>',
      ),
    ).toBe('<dict>\n</dict>');
  });

  test('names the detached helper bundle with the variant identity', () => {
    expect(
      createVariantHelperInfo(
        'com.inkeep.open-knowledge.server OpenKnowledge Server OpenKnowledge Helper',
        'beta',
      ),
    ).toBe(
      'com.inkeep.open-knowledge.beta.server OpenKnowledge Beta Server OpenKnowledge Beta Helper',
    );
  });

  test('transforms every committed packaging template for both variants', () => {
    const installer = readFileSync(resolve(desktopRoot, 'build/installer.nsh'), 'utf8');
    const postInstall = readFileSync(resolve(desktopRoot, 'build/deb-postinst.sh'), 'utf8');
    const postRemove = readFileSync(resolve(desktopRoot, 'build/deb-postrm.sh'), 'utf8');
    const entitlements = readFileSync(resolve(desktopRoot, 'build/entitlements.mac.plist'), 'utf8');
    const helperInfo = readFileSync(resolve(desktopRoot, 'build/helper-bundle/Info.plist'), 'utf8');

    for (const variant of ['stable', 'beta'] as const) {
      expect(() => createVariantNsisInclude(installer, variant)).not.toThrow();
      expect(() => createVariantPostInstall(postInstall, variant)).not.toThrow();
      expect(() => createVariantPostRemove(postRemove, variant)).not.toThrow();
      expect(() => createVariantHelperInfo(helperInfo, variant)).not.toThrow();
    }
    expect(() => createLocalEntitlements(entitlements)).not.toThrow();
  });

  test('fails closed when a packaging template loses a required anchor', () => {
    expect(() => createVariantNsisInclude('openknowledge://', 'beta')).toThrow(/registry key/);
    expect(() => createVariantPostInstall('ln -sf "$OK_WRAPPER" /usr/bin/ok', 'beta')).toThrow(
      /open-knowledge install command/,
    );
    expect(() => createVariantPostRemove('missing', 'beta')).toThrow(/removal loop/);
    expect(() => createLocalEntitlements('<dict/>')).toThrow(/associated-domains/);
    expect(() => createVariantHelperInfo('OpenKnowledge Server', 'beta')).toThrow(
      /bundle identifier/,
    );
  });
});

const WRAPPER_CELLS = Object.keys(DESKTOP_VARIANTS).flatMap((variant) =>
  ['--linux', '--win', '--mac'].flatMap((target) =>
    (['darwin', 'win32', 'linux'] as const).map((platform) => ({ variant, target, platform })),
  ),
);

describe('electron-builder wrapper execution', () => {
  const baseRebuild = parseYaml(
    readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8'),
  ).npmRebuild;

  test.each(WRAPPER_CELLS)(
    'runs $variant $target on $platform through Node with the target rebuild policy',
    async ({ variant, target, platform }) => {
      const { fixture, result } = await runBuilder(
        [target, '--publish', 'never'],
        0,
        false,
        platform,
        variant,
      );
      expect(result.status, result.stderr).toBe(0);
      const entry = join(fixture, 'node_modules/electron-builder/cli.js');
      const args = [
        target,
        '--publish',
        'never',
        '--config',
        '.variant-build/electron-builder.yml',
      ];
      expect(JSON.parse(readFileSync(join(fixture, 'spawn.json'), 'utf8'))).toEqual({
        command: process.execPath,
        args: [entry, ...args],
        shell: false,
        platform,
      });
      expect(JSON.parse(readFileSync(join(fixture, 'invocation.json'), 'utf8'))).toEqual({
        execPath: process.execPath,
        entry,
        args,
        cwd: fixture,
        marker: 'forwarded',
      });
      const generated = parseYaml(
        readFileSync(join(fixture, '.variant-build/electron-builder.yml'), 'utf8'),
      );
      expect(generated.npmRebuild).toBe(target === '--linux' ? false : baseRebuild);
      if (target === '--mac') {
        const manifest = parseYaml(
          readFileSync(join(fixture, 'dist-desktop/latest-mac.yml'), 'utf8'),
        );
        expect(manifest.minimumSystemVersion).toBe(MAC_UPDATE_MINIMUM_DARWIN_VERSION);
        expect(manifest.version).toBe('1.0.0');
      }
    },
  );

  test('fails a macOS package whose builder wrote no update manifest', async () => {
    const { result } = await runBuilder(
      ['--mac', '--publish', 'never'],
      0,
      false,
      'darwin',
      'stable',
      false,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('wrote no macOS update manifest');
    expect(result.stderr).toContain('[OK_PACKAGING_UPDATE_MANIFEST_FAILURE]');
  });

  test('an unpacked --mac --dir build leaves any manifest unstamped', async () => {
    const { fixture, result } = await runBuilder(
      ['--mac', '--dir', '--publish', 'never'],
      0,
      false,
      'darwin',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture, 'dist-desktop/latest-mac.yml'), 'utf8')).toBe(MAC_MANIFEST);
  });

  test('a failing --mac build forwards its own status instead of the manifest check', async () => {
    const { result } = await runBuilder(
      ['--mac', '--publish', 'never'],
      7,
      false,
      'darwin',
      'stable',
      false,
    );
    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain('update manifest');
  });

  test('forwards a failing builder exit status', async () => {
    const { result } = await runBuilder(['--linux'], 7);
    expect(result.status, result.stderr).toBe(7);
  });

  test('reports a signaled builder as failure', async () => {
    const { result } = await runBuilder(['--linux'], 0, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('electron-builder terminated by SIGTERM');
  });

  test('the direct Linux overlay disables native rebuilds as well', () => {
    const overlay = parseYaml(
      readFileSync(join(desktopRoot, 'electron-builder.linux.yml'), 'utf8'),
    );
    expect(overlay.npmRebuild).toBe(false);
  });
});
