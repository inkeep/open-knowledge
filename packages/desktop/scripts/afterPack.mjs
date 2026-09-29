#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
import { ensureNodePtySpawnHelperExecutable } from './ensure-node-pty-exec.mjs';
import { createFuseFailure } from './packaging-diagnostics.mjs';
import { resolveElectronBinary } from './resolve-electron-binary.mjs';
import { targetFuses } from './target-fuses.mjs';

async function flipElectronFuses(electronBinary, electronPlatformName) {
  console.log(`[afterPack] flipping fuses on ${electronBinary}`);
  for (const [optIndex, value] of Object.entries(targetFuses)) {
    const name = FuseV1Options[Number(optIndex)];
    console.log(`[afterPack]   ${name} = ${value}`);
  }

  try {
    await flipFuses(electronBinary, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: electronPlatformName === 'darwin',
      ...targetFuses,
    });
  } catch (err) {
    throw createFuseFailure(
      `[afterPack] fuse flip failed on ${electronBinary}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  console.log('[afterPack] fuses flipped successfully; electron-builder will re-sign next');
}

export function assertAdHocSealCoversBundle(appPath) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=3', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (typeof err?.status !== 'number') {
      throw createFuseFailure(
        `[afterPack] could not run /usr/bin/codesign to verify the ad-hoc seal on ${appPath}: ` +
          `${err?.code ?? err?.signal ?? (err instanceof Error ? err.message : String(err))}`,
        { cause: err },
      );
    }
    const lines = `${err.stderr ?? ''}\n${err.stdout ?? ''}`
      .split('\n')
      .filter((line) => line.trim() !== '' && !/^--(prepared|validated):/.test(line));
    throw createFuseFailure(
      `[afterPack] codesign --verify --deep --strict rejected ${appPath} after the fuse flip ` +
        `re-sealed it ad hoc, so electron-builder's signer would meet the same nested ` +
        `signature. Either a bundle changed after the seal or the re-seal left an invalid ` +
        `nested signature. codesign exited ${err.status}:\n${[...new Set(lines)].join('\n')}`,
      { cause: err },
    );
  }
  console.log('[afterPack] ad-hoc seal verified across every nested bundle');
}

export default async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  if (appOutDir.endsWith('-temp')) {
    console.log(
      `[afterPack] skipping per-arch temp "${appOutDir}" — fuses flip on the merged universal app`,
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const electronBinary = resolveElectronBinary(electronPlatformName, appOutDir, packager);

  if (!existsSync(electronBinary)) {
    throw new Error(
      `[afterPack] Electron binary not found at ${electronBinary}. ` +
        `Expected electron-builder to have packed the app before afterPack ran.`,
    );
  }

  if (electronPlatformName !== 'darwin') {
    await flipElectronFuses(electronBinary, electronPlatformName);
    console.log(
      `[afterPack] fuses done; skipping darwin-only helper-bundle + node-pty steps on "${electronPlatformName}"`,
    );
    return;
  }

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
    `${appName} Server.app`,
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

  await flipElectronFuses(electronBinary, electronPlatformName);
  assertAdHocSealCoversBundle(join(appOutDir, `${appName}.app`));
}
