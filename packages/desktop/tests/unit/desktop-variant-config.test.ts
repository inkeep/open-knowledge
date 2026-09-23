import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
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

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
      publish: [{ channel: 'beta' }],
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

  test('invokes the builder JavaScript entrypoint without a Windows command shim', () => {
    const wrapper = readFileSync(resolve(desktopRoot, 'scripts/run-electron-builder.mjs'), 'utf8');
    expect(wrapper).toContain("require.resolve('electron-builder/cli.js')");
    expect(wrapper).toMatch(/spawnSync\(\s*process\.execPath/);
    expect(wrapper).not.toContain('pnpm.cmd');
    expect(wrapper).toMatch(/electron-builder terminated by \$\{result\.signal\}/);
  });

  test('keeps direct and generated Linux configs aligned on the rebuild policy', () => {
    const wrapper = readFileSync(resolve(desktopRoot, 'scripts/run-electron-builder.mjs'), 'utf8');
    const overlay = readFileSync(resolve(desktopRoot, 'electron-builder.linux.yml'), 'utf8');
    expect(wrapper).toContain("if (args.includes('--linux')) config.npmRebuild = false;");
    expect(overlay).toMatch(/^npmRebuild:\s*false$/m);
  });
});
