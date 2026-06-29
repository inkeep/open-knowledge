#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
import { ensureNodePtySpawnHelperExecutable } from './ensure-node-pty-exec.mjs';
import { targetFuses } from './target-fuses.mjs';

export default async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin') {
    console.log(`[afterPack] skipping fuses on platform "${electronPlatformName}"`);
    return;
  }

  if (appOutDir.endsWith('-temp')) {
    console.log(
      `[afterPack] skipping per-arch temp "${appOutDir}" — fuses flip on the merged universal app`,
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const electronBinary = join(appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName);

  if (!existsSync(electronBinary)) {
    throw new Error(
      `[afterPack] Electron binary not found at ${electronBinary}. ` +
        `Expected electron-builder to have packed the .app before afterPack ran.`,
    );
  }

  console.log(`[afterPack] flipping fuses on ${electronBinary}`);
  for (const [optIndex, value] of Object.entries(targetFuses)) {
    const name = FuseV1Options[Number(optIndex)];
    console.log(`[afterPack]   ${name} = ${value}`);
  }

  try {
    await flipFuses(electronBinary, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      ...targetFuses,
    });
  } catch (err) {
    throw new Error(
      `[afterPack] fuse flip failed on ${electronBinary}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  console.log('[afterPack] fuses flipped successfully; electron-builder will re-sign next');

  const electronHelperStub = join(
    appOutDir,
    `${appName}.app`,
    'Contents',
    'Frameworks',
    `${appName} Helper.app`,
    'Contents',
    'MacOS',
    `${appName} Helper`,
  );
  const serverHelperBundleDir = join(
    appOutDir,
    `${appName}.app`,
    'Contents',
    'Frameworks',
    'OpenKnowledge Server.app',
  );
  const serverHelperBinary = join(serverHelperBundleDir, 'Contents', 'MacOS', `${appName} Helper`);
  if (!existsSync(electronHelperStub)) {
    throw new Error(
      `[afterPack] Electron Helper stub not found at ${electronHelperStub}. ` +
        `Cannot clone it into the OpenKnowledge Server helper bundle.`,
    );
  }
  const serverHelperMacOsDir = dirname(serverHelperBinary);
  if (!existsSync(serverHelperMacOsDir)) {
    try {
      mkdirSync(serverHelperMacOsDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `[afterPack] failed to create MacOS dir for helper bundle at ${serverHelperMacOsDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  }
  try {
    copyFileSync(electronHelperStub, serverHelperBinary);
  } catch (err) {
    throw new Error(
      `[afterPack] failed to copy Electron Helper stub to ${serverHelperBinary}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  try {
    chmodSync(serverHelperBinary, 0o755);
  } catch (err) {
    throw new Error(
      `[afterPack] failed to chmod cloned helper binary at ${serverHelperBinary}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  const serverHelperPkgInfo = join(serverHelperBundleDir, 'Contents', 'PkgInfo');
  try {
    writeFileSync(serverHelperPkgInfo, 'APPL????');
  } catch (err) {
    throw new Error(
      `[afterPack] failed to write PkgInfo at ${serverHelperPkgInfo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  console.log(
    `[afterPack] cloned Electron Helper stub into OpenKnowledge Server.app MacOS slot at ${serverHelperBinary}`,
  );

  const resourcesDir = join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
  const ptyHelpers = ensureNodePtySpawnHelperExecutable(resourcesDir);
  console.log(`[afterPack] node-pty spawn-helper marked executable (${ptyHelpers.length} file(s))`);
}
