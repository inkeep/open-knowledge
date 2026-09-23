#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { DESKTOP_VARIANTS, parseDesktopVariantName } from '../src/shared/desktop-variant.ts';
import {
  createLocalEntitlements,
  createVariantBuilderConfig,
  createVariantHelperInfo,
  createVariantNsisInclude,
  createVariantPostInstall,
  createVariantPostRemove,
  parseBuilderConfig,
} from './desktop-variant-config.ts';

const variantName = parseDesktopVariantName(process.env.OK_DESKTOP_VARIANT);
const variant = DESKTOP_VARIANTS[variantName];
const args = process.argv.slice(2);
const buildDir = join(process.cwd(), '.variant-build');
const profilePath = join(process.cwd(), `build/embedded.${variantName}.provisionprofile`);
const profileAvailable = variantName === 'stable' || existsSync(profilePath);
const packagingMac = args.includes('--mac') || args.includes('--dir');
const signingRequested = Boolean(process.env.CSC_LINK || process.env.CSC_KEYCHAIN);

if (packagingMac && signingRequested && !profileAvailable) {
  throw new Error(
    `${variant.productName} cannot be signed with associated domains until ${profilePath} exists.`,
  );
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

const includePath = '.variant-build/installer.nsh';
const postInstallPath = '.variant-build/deb-postinst.sh';
const postRemovePath = '.variant-build/deb-postrm.sh';
const localEntitlementsPath = '.variant-build/entitlements.mac.local.plist';
const helperInfoPath = '.variant-build/helper-Info.plist';

const base = parseBuilderConfig(readFileSync('electron-builder.yml', 'utf8'));
const sourceVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const config = createVariantBuilderConfig(
  base,
  variantName,
  {
    includePath,
    postInstallPath,
    postRemovePath,
    localEntitlementsPath,
    helperInfoPath,
    profileAvailable,
  },
  sourceVersion,
);
if (args.includes('--linux')) config.npmRebuild = false;

writeFileSync(
  includePath,
  createVariantNsisInclude(readFileSync('build/installer.nsh', 'utf8'), variantName),
);
writeFileSync(
  postInstallPath,
  createVariantPostInstall(readFileSync('build/deb-postinst.sh', 'utf8'), variantName),
);
writeFileSync(
  postRemovePath,
  createVariantPostRemove(readFileSync('build/deb-postrm.sh', 'utf8'), variantName),
);
writeFileSync(
  localEntitlementsPath,
  createLocalEntitlements(readFileSync('build/entitlements.mac.plist', 'utf8')),
);
writeFileSync(
  helperInfoPath,
  createVariantHelperInfo(readFileSync('build/helper-bundle/Info.plist', 'utf8'), variantName),
);
const generatedConfigPath = '.variant-build/electron-builder.yml';
writeFileSync(generatedConfigPath, stringifyYaml(config, { lineWidth: 0 }));

const require = createRequire(import.meta.url);
const electronBuilderCli = require.resolve('electron-builder/cli.js');
const result = spawnSync(
  process.execPath,
  [electronBuilderCli, ...args, '--config', generatedConfigPath],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.signal) {
  console.error(`[desktop-builder] electron-builder terminated by ${result.signal}`);
}
process.exit(result.status ?? 1);
