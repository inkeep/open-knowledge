import { parse as parseYaml } from 'yaml';
import { DESKTOP_VARIANTS, type DesktopVariantName } from '../src/shared/desktop-variant.ts';

interface ResourceEntry {
  from: string;
  to: string;
  filter?: string[];
}

interface LinuxPackageTargetConfig {
  afterInstall: string;
  afterRemove: string;
  packageName?: string;
  depends?: string[];
}

interface BuilderConfig {
  appId: string;
  productName: string;
  extraMetadata?: Record<string, unknown>;
  protocols: Array<{ name: string; schemes: string[]; role?: string }>;
  publish: Array<{
    provider: string;
    owner: string;
    repo: string;
    channel: string;
    private?: boolean;
  }>;
  mac: {
    icon: string;
    artifactName?: string;
    entitlements: string;
    provisioningProfile?: string;
    extraResources: ResourceEntry[];
    extraFiles: ResourceEntry[];
    extendInfo?: Record<string, unknown>;
  };
  win: { icon: string; extraResources: ResourceEntry[] };
  dmg: { artifactName: string };
  linux: {
    icon: string;
    artifactName: string;
    executableName: string;
    extraResources: ResourceEntry[];
  };
  nsis: { artifactName: string; include: string };
  deb: LinuxPackageTargetConfig;
  rpm: LinuxPackageTargetConfig;
  npmRebuild?: boolean;
}

export interface VariantConfigPaths {
  readonly includePath: string;
  readonly postInstallPath: string;
  readonly postRemovePath: string;
  readonly localEntitlementsPath: string;
  readonly helperInfoPath: string;
  readonly profileAvailable: boolean;
}

function replaceRequired(
  source: string,
  search: string | RegExp,
  replacement: string,
  label: string,
): string {
  const found = typeof search === 'string' ? source.includes(search) : search.test(source);
  if (!found) throw new Error(`Desktop packaging template is missing ${label}.`);
  return source.replace(search, replacement);
}

function replaceAllRequired(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (!source.includes(search)) throw new Error(`Desktop packaging template is missing ${label}.`);
  return source.replaceAll(search, replacement);
}

export function parseBuilderConfig(text: string): BuilderConfig {
  return parseYaml(text) as BuilderConfig;
}

export function createVariantBuilderConfig(
  base: BuilderConfig,
  variantName: DesktopVariantName,
  paths: VariantConfigPaths,
  sourceVersion: string,
): BuilderConfig {
  const variant = DESKTOP_VARIANTS[variantName];
  const config = structuredClone(base);
  config.appId = variant.appId;
  config.productName = variant.productName;
  config.extraMetadata = {
    ...config.extraMetadata,
    okDesktopVariant: variant.name,
    productName: variant.productName,
    ...(variant.name === 'stable' ? {} : { name: variant.packageName }),
    ...(variant.name === 'beta' ? { version: betaBuildVersion(sourceVersion) } : {}),
  };
  config.protocols = [
    { name: `${variant.productName} URL`, schemes: [variant.protocolScheme], role: 'Editor' },
  ];
  config.publish = config.publish.map((entry) => ({
    ...entry,
    channel: variant.updateChannel,
  }));
  config.mac.icon = variant.name === 'stable' ? config.mac.icon : variant.iconPath;
  config.mac.artifactName = `${variant.artifactName}-\${version}-\${arch}-mac.\${ext}`;
  config.win.icon = variant.iconPath;
  config.linux.icon = variant.iconPath;
  config.dmg.artifactName = `${variant.artifactName}-\${arch}.\${ext}`;
  config.nsis.artifactName = `${variant.artifactName}-Setup-\${arch}.\${ext}`;
  config.linux.artifactName = `${variant.artifactName}-\${arch}.\${ext}`;
  config.linux.executableName = variant.linuxExecutableName;
  config.deb.packageName = variant.linuxPackageNames.deb;
  config.rpm.packageName = variant.linuxPackageNames.rpm;
  config.nsis.include = paths.includePath;
  config.deb.afterInstall = paths.postInstallPath;
  config.deb.afterRemove = paths.postRemovePath;
  config.rpm.afterInstall = paths.postInstallPath;
  config.rpm.afterRemove = paths.postRemovePath;
  config.mac.extendInfo = {
    ...config.mac.extendInfo,
    NSMicrophoneUsageDescription: `A program running in ${variant.productName}'s terminal wants to use the microphone.`,
  };
  config.mac.extraFiles = [
    {
      from: paths.helperInfoPath,
      to: `Frameworks/${variant.productName} Server.app/Contents/Info.plist`,
    },
  ];
  if (variant.name === 'stable' || paths.profileAvailable) {
    config.mac.provisioningProfile =
      variant.name === 'stable'
        ? 'build/embedded.provisionprofile'
        : `build/embedded.${variant.name}.provisionprofile`;
  } else {
    delete config.mac.provisioningProfile;
    config.mac.entitlements = paths.localEntitlementsPath;
  }
  if (variant.name === 'beta') {
    const wrapperEntries = config.win.extraResources.filter(
      (entry) =>
        entry.from !== 'resources/cli/bin/ok.cmd' && entry.from !== 'resources/cli/bin/ok.ps1',
    );
    config.win.extraResources = [
      ...variant.cliCommandNames.flatMap((name) => [
        { from: 'resources/cli/bin/ok.cmd', to: `cli/bin/${name}.cmd` },
        { from: 'resources/cli/bin/ok.ps1', to: `cli/bin/${name}.ps1` },
      ]),
      ...wrapperEntries,
    ];
  }
  return config;
}

export function betaBuildVersion(sourceVersion: string): string {
  const base = /^\d+\.\d+\.\d+/.exec(sourceVersion)?.[0];
  if (!base)
    throw new Error(`Desktop package version ${JSON.stringify(sourceVersion)} is invalid.`);
  return /-beta\.\d+(?:\+.*)?$/.test(sourceVersion) ? sourceVersion : `${base}-beta.0`;
}

export function createVariantNsisInclude(source: string, variantName: DesktopVariantName): string {
  const variant = DESKTOP_VARIANTS[variantName];
  const withScheme = replaceAllRequired(
    source,
    'openknowledge://',
    `${variant.protocolScheme}://`,
    'the openknowledge:// URL scheme in build/installer.nsh',
  );
  const withRegistryKey = replaceAllRequired(
    withScheme,
    'Software\\Classes\\openknowledge',
    `Software\\Classes\\${variant.protocolScheme}`,
    'the openknowledge registry key in build/installer.nsh',
  );
  return replaceAllRequired(
    withRegistryKey,
    'URL:OpenKnowledge',
    `URL:${variant.productName}`,
    'the OpenKnowledge protocol label in build/installer.nsh',
  );
}

export function createVariantPostInstall(source: string, variantName: DesktopVariantName): string {
  const [shortName, longName] = DESKTOP_VARIANTS[variantName].cliCommandNames;
  const withShortName = replaceRequired(
    source,
    'ln -sf "$OK_WRAPPER" /usr/bin/ok',
    `ln -sf "$OK_WRAPPER" /usr/bin/${shortName}`,
    'the /usr/bin/ok install command in build/deb-postinst.sh',
  );
  return replaceRequired(
    withShortName,
    'ln -sf "$OK_WRAPPER" /usr/bin/open-knowledge',
    `ln -sf "$OK_WRAPPER" /usr/bin/${longName}`,
    'the /usr/bin/open-knowledge install command in build/deb-postinst.sh',
  );
}

export function createVariantPostRemove(source: string, variantName: DesktopVariantName): string {
  const [shortName, longName] = DESKTOP_VARIANTS[variantName].cliCommandNames;
  return replaceRequired(
    source,
    'for link in /usr/bin/ok /usr/bin/open-knowledge; do',
    `for link in /usr/bin/${shortName} /usr/bin/${longName}; do`,
    'the Linux CLI removal loop in build/deb-postrm.sh',
  );
}

export function createLocalEntitlements(source: string): string {
  return replaceRequired(
    source,
    /\n\s*<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>[\s\S]*?<\/array>/,
    '',
    'the associated-domains entitlement in build/entitlements.mac.plist',
  );
}

export function createVariantHelperInfo(source: string, variantName: DesktopVariantName): string {
  const variant = DESKTOP_VARIANTS[variantName];
  const withAppId = replaceAllRequired(
    source,
    'com.inkeep.open-knowledge.server',
    `${variant.appId}.server`,
    'the helper bundle identifier in build/helper-bundle/Info.plist',
  );
  const withServerName = replaceAllRequired(
    withAppId,
    'OpenKnowledge Server',
    `${variant.productName} Server`,
    'the helper bundle name in build/helper-bundle/Info.plist',
  );
  return replaceAllRequired(
    withServerName,
    'OpenKnowledge Helper',
    `${variant.productName} Helper`,
    'the helper executable name in build/helper-bundle/Info.plist',
  );
}
