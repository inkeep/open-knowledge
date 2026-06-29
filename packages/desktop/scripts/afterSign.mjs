#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { notarize } from '@electron/notarize';
import { expectedFuseState, fuseStateName, targetFuses } from './target-fuses.mjs';

function collectMissing(required) {
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function resolveNotarizeCredentials() {
  const {
    APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID,
    APPLE_API_KEY,
    APPLE_API_KEY_ID,
    APPLE_API_ISSUER,
    APPLE_KEYCHAIN_PROFILE,
    APPLE_KEYCHAIN,
  } = process.env;

  const hasAnyPassword = Boolean(APPLE_ID || APPLE_APP_SPECIFIC_PASSWORD);
  const hasAnyApiKey = Boolean(APPLE_API_KEY || APPLE_API_KEY_ID || APPLE_API_ISSUER);
  const hasAnyKeychain = Boolean(APPLE_KEYCHAIN_PROFILE || APPLE_KEYCHAIN);

  const activeShapes = [
    hasAnyPassword && 'password',
    hasAnyApiKey && 'api-key',
    hasAnyKeychain && 'keychain',
  ].filter(Boolean);

  if (activeShapes.length === 0) {
    return null;
  }

  if (activeShapes.length > 1) {
    throw new Error(
      `[afterSign] Multiple Apple credential shapes detected (${activeShapes.join(' + ')}) — ` +
        `set exactly one of: password (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID), ` +
        `API key (APPLE_API_KEY + APPLE_API_KEY_ID [+ APPLE_API_ISSUER]), or ` +
        `keychain profile (APPLE_KEYCHAIN_PROFILE [+ APPLE_KEYCHAIN]).`,
    );
  }

  if (hasAnyPassword) {
    const missing = collectMissing({
      APPLE_ID,
      APPLE_APP_SPECIFIC_PASSWORD,
      APPLE_TEAM_ID,
    });
    if (missing.length > 0) {
      throw new Error(
        `[afterSign] Partial Apple password credentials — missing: ${missing.join(', ')}. ` +
          `All three of APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID must be set together. ` +
          `Refusing to silently skip notarize with partial credentials.`,
      );
    }
    return {
      kind: 'password',
      creds: {
        appleId: APPLE_ID,
        appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
        teamId: APPLE_TEAM_ID,
      },
    };
  }

  if (hasAnyApiKey) {
    const missing = collectMissing({
      APPLE_API_KEY,
      APPLE_API_KEY_ID,
    });
    if (missing.length > 0) {
      throw new Error(
        `[afterSign] Partial Apple API-key credentials — missing: ${missing.join(', ')}. ` +
          `Both APPLE_API_KEY and APPLE_API_KEY_ID must be set together (APPLE_API_ISSUER is optional). ` +
          `Refusing to silently skip notarize with partial credentials.`,
      );
    }
    return {
      kind: 'api-key',
      creds: {
        appleApiKey: APPLE_API_KEY,
        appleApiKeyId: APPLE_API_KEY_ID,
        ...(APPLE_API_ISSUER ? { appleApiIssuer: APPLE_API_ISSUER } : {}),
      },
    };
  }

  if (!APPLE_KEYCHAIN_PROFILE) {
    throw new Error(
      `[afterSign] Partial Apple keychain credentials — missing: APPLE_KEYCHAIN_PROFILE. ` +
        `APPLE_KEYCHAIN alone is not usable; set APPLE_KEYCHAIN_PROFILE (created via ` +
        `'xcrun notarytool store-credentials'). Refusing to silently skip notarize with partial credentials.`,
    );
  }
  return {
    kind: 'keychain',
    creds: {
      keychainProfile: APPLE_KEYCHAIN_PROFILE,
      ...(APPLE_KEYCHAIN ? { keychain: APPLE_KEYCHAIN } : {}),
    },
  };
}

async function verifyFuses(electronBinary, expected) {
  let wire;
  try {
    wire = await getCurrentFuseWire(electronBinary);
  } catch (err) {
    throw new Error(
      `[afterSign] getCurrentFuseWire failed on ${electronBinary}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  const mismatches = [];
  for (const [optIndex, expectedValue] of Object.entries(expected)) {
    const key = Number(optIndex);
    const actualState = wire[key];
    const expectedState = expectedFuseState(expectedValue);
    if (actualState !== expectedState) {
      mismatches.push(
        `${FuseV1Options[key]}: expected ${fuseStateName(expectedState)} ` +
          `(target=${expectedValue}), got ${fuseStateName(actualState)}`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `[afterSign] Fuse verification failed (D17 paranoid check):\n  ${mismatches.join('\n  ')}`,
    );
  }
  console.log('[afterSign] fuse verification passed — all 6 fuses match targetFuses');
}

export default async function afterSign(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin') {
    console.log(`[afterSign] skipping on platform "${electronPlatformName}"`);
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = join(appOutDir, `${appName}.app`);
  const electronBinary = join(appPath, 'Contents', 'MacOS', appName);

  if (!existsSync(appPath)) {
    throw new Error(`[afterSign] .app bundle not found at ${appPath}`);
  }

  await verifyFuses(electronBinary, targetFuses);

  const credentials = resolveNotarizeCredentials();

  if (!credentials) {
    console.log(
      '[afterSign] skipping notarize — no Apple credentials in env ' +
        '(APPLE_ID+APPLE_APP_SPECIFIC_PASSWORD+APPLE_TEAM_ID, APPLE_API_KEY+APPLE_API_KEY_ID, ' +
        'or APPLE_KEYCHAIN_PROFILE). Build continues as unsigned smoke.',
    );
    return;
  }

  console.log(`[afterSign] notarizing ${appPath} via ${credentials.kind} credentials`);
  console.log('[afterSign]   this typically takes 1-5 minutes...');

  try {
    await notarize({
      appPath,
      ...credentials.creds,
    });
  } catch (err) {
    throw new Error(
      `[afterSign] notarize failed (credential kind: ${credentials.kind}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  console.log('[afterSign] notarize + staple complete; validating stapled ticket');
  try {
    execFileSync('xcrun', ['stapler', 'validate', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err && err.stderr
        ? err.stderr.toString().trim()
        : '';
    const stdout =
      err && typeof err === 'object' && 'stdout' in err && err.stdout
        ? err.stdout.toString().trim()
        : '';
    if (stdout) console.error(`[afterSign] stapler stdout: ${stdout}`);
    if (stderr) console.error(`[afterSign] stapler stderr: ${stderr}`);
    throw new Error(
      `[afterSign] stapler validation failed — notarization succeeded but ticket was not ` +
        `stapled correctly. This will cause Gatekeeper warnings on first launch. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}` +
        (stderr ? `\nstapler stderr: ${stderr}` : '') +
        (stdout ? `\nstapler stdout: ${stdout}` : ''),
      { cause: err },
    );
  }

  await verifyFuses(electronBinary, targetFuses);

  console.log('[afterSign] signed + notarized + stapled + fuse-verified successfully');
}
