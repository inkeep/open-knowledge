#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
import { ensureNodePtySpawnHelperExecutable } from './ensure-node-pty-exec.mjs';
import { targetFuses } from './target-fuses.mjs';

/**
 * electron-builder `afterPack` hook — runs on the packed `.app` bundle before
 * code-signing. We flip the Electron fuses to harden the runtime: disable
 * NODE_OPTIONS env ingestion, require asar integrity validation, and only load
 * app code from asar. Cookie encryption is ON as a defense-in-depth hygiene
 * fuse. EnableNodeCliInspect is left ON because Playwright's `_electron.launch`
 * requires the inspect CLI arguments to attach.
 *
 * RunAsNode is ENABLED. The bundled `ok.sh` wrapper needs
 * `ELECTRON_RUN_AS_NODE=1` to work in packaged builds; VS Code + Atom
 * precedent. Full rationale + defense-in-depth argument at `./target-fuses.mjs`.
 *
 * Fuses are flipped BEFORE the Developer ID signature is applied — electron
 * ships with an ad-hoc Darwin signature that flipFuses would invalidate, so
 * we set `resetAdHocDarwinSignature: true` to keep the intermediate binary
 * in a valid ad-hoc-signed state until electron-builder re-signs with the
 * Developer ID cert.
 *
 * Post-sign verification of these same fuses lives in `afterSign.mjs`
 * ("Windows signtool has shipped silent fuse-clobber regressions; paranoid
 * verification is load-bearing"). Both hooks import the same `targetFuses`
 * map from `./target-fuses.mjs` — flip-time and verify-time cannot drift.
 */

export default async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  // electron-builder runs afterPack once per target platform. We only flip
  // fuses on macOS for now. When Windows/Linux builds arrive in a later
  // milestone, widen this guard.
  if (electronPlatformName !== 'darwin') {
    console.log(`[afterPack] skipping fuses on platform "${electronPlatformName}"`);
    return;
  }

  // Universal builds: electron-builder packs arm64 and x64 into separate
  // `mac-universal-<arch>-temp` dirs, fires afterPack on each, then calls
  // @electron/universal.makeUniversalApp to merge them. That merge asserts
  // that all non-Mach-O files have identical SHAs across arches — and
  // flipping fuses perturbs `Contents/Frameworks/.../CodeSignature/
  // CodeResources` differently per arch, breaking the SHA-parity check.
  // The canonical fix is to only flip fuses on the MERGED universal app
  // (which has a fat Mach-O binary; @electron/fuses v2 handles that shape
  // correctly). Detect the final output dir by the absence of the `-temp`
  // suffix.
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
    // Phase-annotated so a fuse-flip failure is distinguishable from a
    // post-sign verification failure in afterSign.mjs — the remediation
    // paths differ (rollback vs investigate re-sign pipeline).
    throw new Error(
      `[afterPack] fuse flip failed on ${electronBinary}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  console.log('[afterPack] fuses flipped successfully; electron-builder will re-sign next');

  // Detached-server helper bundle: clone the Electron Helper stub binary
  // into our `OpenKnowledge Server.app/Contents/MacOS/` slot. electron-
  // builder's `extraFiles` (in electron-builder.yml) lands the Info.plist
  // alongside but cannot reference output-only artifacts, so the MacOS
  // binary itself is populated here. We source from Electron's own helper
  // stub because its rpath is `@executable_path/../../..` (3 ups, the
  // helper-bundle filesystem position) — sourcing from the parent's main
  // binary would give us a stub whose rpath is `@executable_path/../Frameworks`
  // (1 up) and dyld would fail at child launch. Note that electron-builder
  // renames `Electron Helper.app` → `<productName> Helper.app` during
  // packaging, so we source from the renamed path.
  //
  // The helper bundle's `Info.plist` declares `LSUIElement=true` so the
  // spawned detached server doesn't register a macOS Dock tile — without
  // it, LaunchServices treats the re-exec as a duplicate `.app` launch
  // and pins a stuck "exec" Dock placeholder for the child's lifetime.
  //
  // The cloned binary inside `OpenKnowledge Server.app` MUST be named
  // `<productName> Helper` (matching the canonical Electron generic-helper
  // basename). Electron's helper stub inspects its own `_NSGetExecutablePath()`
  // basename early in boot and SIGTRAPs silently (exit 133, empty stderr)
  // for any other name — including descriptive variants like "OpenKnowledge
  // Server" or invented suffixes like "Helper (Server)" not in Electron's
  // hardcoded {generic, Renderer, GPU, Plugin} type set. The bundle directory
  // name (`OpenKnowledge Server.app`) is free to be descriptive — only the
  // executable basename is load-bearing.
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
      // Phase-annotated to match the fuse-flip + clone error shapes above.
      // EACCES/ENOSPC/EROFS on the output dir all surface here — distinguish
      // from afterSign.mjs verify-time failures so the remediation path
      // (output-dir perms / disk space) is unambiguous.
      throw new Error(
        `[afterPack] failed to create MacOS dir for helper bundle at ${serverHelperMacOsDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  }
  // Split into two phase-annotated blocks — copy vs chmod failures have
  // distinct remediation paths: copy fails on EACCES/ENOSPC/EIO at the
  // output dir (check space + perms on the build output); chmod fails on
  // EPERM (file ownership / SIP-style protection on the target). Keeping
  // them merged would lose the remediation breadcrumb.
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

  // PkgInfo: every Electron helper bundle ships an 8-byte "APPL????" file
  // at `Contents/PkgInfo` (legacy Carbon type+creator code). Missing
  // PkgInfo isn't load-bearing for this binary's startup, but it diverges
  // from the bundle shape every other Electron helper carries and from
  // what LaunchServices expects of an `APPL` package. Add it here so the
  // Server.app bundle is structurally indistinguishable from its sibling
  // Helper bundles.
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

  // node-pty's prebuilt spawn-helper ships 0644 (node-pty#850); the
  // `**/node-pty/prebuilds/**` asarUnpack rule lands it on disk but keeps that
  // mode, so make it executable before electron-builder re-signs.
  const resourcesDir = join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
  const ptyHelpers = ensureNodePtySpawnHelperExecutable(resourcesDir);
  console.log(`[afterPack] node-pty spawn-helper marked executable (${ptyHelpers.length} file(s))`);
}
