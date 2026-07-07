#!/usr/bin/env node
/**
 * Dev-mode smoke harness for the auto-updater pipeline.
 *
 * Spins up a local HTTP server that serves a hand-crafted channel manifest
 * (`latest-mac.yml` or `beta-mac.yml`) + a matching fake `.zip` payload with
 * a valid sha512 hash. Exercises electron-updater's `GenericProvider`
 * download path end-to-end, short of the signature-verified Squirrel.Mac
 * swap (which only real signed DMGs can trigger).
 *
 * ## Usage
 *
 * **Standalone server mode (pure node/bun — this script's primary entry):**
 *
 *     bun run --cwd packages/desktop smoke:mock-update
 *     OK_UPDATER_MOCK_CHANNEL=beta bun run --cwd packages/desktop smoke:mock-update
 *
 * Prints a `[mock-updater] port=<N>` line on stdout, then serves two routes:
 *
 *     GET /<channel>-mac.yml         → hand-crafted YAML manifest
 *     GET /open-knowledge-mock.zip   → fake zip bytes matching yml's sha512
 *
 * Exits 0 after observing a successful GET of both routes, OR after 30s
 * timeout (exit 1). Set `MOCK_UPDATE_TIMEOUT_MS` to override the timeout.
 *
 * **Channel selection.** `OK_UPDATER_MOCK_CHANNEL` selects which channel
 * the harness simulates. Valid values: `latest` (default) or `beta`. Other
 * values fail fast with exit 2. Beta runs default the artifact version to
 * `0.4.0-beta.0`, embed `channel: beta` in the manifest body, and write the
 * dev-app-update.yml with the matching channel field — so a paired Electron
 * dev build configured with `autoUpdater.channel = 'beta'` can fetch the
 * beta manifest end-to-end.
 *
 * **Pair with an Electron dev build (the full round-trip):**
 *
 *   1. Terminal A: `bun run --cwd packages/desktop smoke:mock-update -- --keep-alive`
 *      Note the port printed — the server keeps serving until Ctrl+C.
 *   2. Terminal B: `OK_UPDATER_FORCE_DEV=1 OK_UPDATER_FEED_URL=http://127.0.0.1:<N> bun run --filter=@inkeep/open-knowledge-desktop dev`
 *   3. Electron's main-process auto-updater hits the local server, downloads
 *      the fake zip, and fires `update-downloaded`. Renderer Toast A renders
 *      ("Update downloaded" + "Relaunch now") within 2-3 seconds of boot.
 *
 * Without `--keep-alive`, the script exits 0 after its built-in self-test
 * (CI mode — validates HTTP serving + sha512 without waiting for Electron).
 *
 * Uses GenericProvider + setFeedURL via forceDevUpdateConfig. Distinct from the
 * event-stub subclass approach exercised by `tests/integration/auto-updater.test.ts`.
 *
 * ## Why this script doesn't import electron-updater directly
 *
 * electron-updater's `autoUpdater` export is lazily constructed and its
 * platform-specific subclass (MacUpdater, NsisUpdater) requires
 * `require('electron').autoUpdater` at construction time — fails under plain
 * node/bun. The Tier-2 round-trip therefore splits into two processes: the
 * local HTTP server (this script, node/bun) and the Electron dev build
 * (normal `bun run dev --filter=@inkeep/open-knowledge-desktop`).
 *
 * ## Structured log shape
 *
 *     [mock-updater] port=<N>
 *     [mock-updater] event=start channel=<latest|beta> version=<V>
 *     [mock-updater] event=served path=/<channel>-mac.yml status=200
 *     [mock-updater] event=served path=/open-knowledge-mock.zip status=200 bytes=<len>
 *     [mock-updater] event=manifest-and-zip-served — Electron dev build can verify update-downloaded
 *     [mock-updater] event=shutdown reason=<timeout|signal|done>
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const SUPPORTED_CHANNELS = /** @type {const} */ (['latest', 'beta']);
const RAW_CHANNEL = process.env.OK_UPDATER_MOCK_CHANNEL ?? 'latest';
if (!SUPPORTED_CHANNELS.includes(/** @type {any} */ (RAW_CHANNEL))) {
  console.error(
    `[mock-updater] event=fatal message=unsupported OK_UPDATER_MOCK_CHANNEL=${RAW_CHANNEL} (expected one of: ${SUPPORTED_CHANNELS.join(', ')})`,
  );
  process.exit(2);
}
/** @type {'latest' | 'beta'} */
const CHANNEL = /** @type {'latest' | 'beta'} */ (RAW_CHANNEL);
const MANIFEST_NAME = `${CHANNEL}-mac.yml`;
// Default version per channel; either is overridable via MOCK_UPDATE_VERSION.
// Beta default carries a real semver prerelease tag so the manifest looks
// like a release a beta-channel client would actually fetch in the field.
const DEFAULT_VERSION = CHANNEL === 'beta' ? '0.4.0-beta.0' : '0.99.0-mock';
const VERSION = process.env.MOCK_UPDATE_VERSION ?? DEFAULT_VERSION;
const TIMEOUT_MS = Number.parseInt(process.env.MOCK_UPDATE_TIMEOUT_MS ?? '30000', 10);
/**
 * `--keep-alive` skips the auto-shutdown after self-test and keeps serving
 * until the process is killed (Ctrl+C, SIGTERM). Used for the 2-terminal
 * manual Tier-2 flow where the Electron dev app needs the server to stay up.
 * When keep-alive is set, this script also writes `dev-app-update.yml` next
 * to `packages/desktop/package.json` with the chosen port — electron-updater
 * reads that file at `checkForUpdates()` time. Cleaned up on SIGINT/SIGTERM.
 */
const KEEP_ALIVE = process.argv.includes('--keep-alive');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(__dirname, '..');
const DEV_APP_UPDATE_YML = resolve(DESKTOP_ROOT, 'dev-app-update.yml');

/**
 * Build a minimal valid .zip archive with a single text file. The zip format
 * has a precise local-file-header + central-directory layout; we emit the
 * smallest valid blob so electron-updater's download-verification + unpack
 * path can round-trip without native zip tooling.
 *
 * Structure:
 *   - Local file header + compressed data for "payload.txt"
 *   - Central directory entry pointing at the local header
 *   - End-of-central-directory record
 *
 * Returns the full byte buffer.
 */
function buildMinimalZip() {
  const filename = 'payload.txt';
  const contents = Buffer.from(
    `OpenKnowledge M3 mock update payload\nversion=${VERSION}\ntimestamp=${new Date().toISOString()}\n`,
    'utf-8',
  );
  const compressed = deflateRawSync(contents);
  // Minimal CRC-32 implementation — zip requires this (crc of uncompressed bytes).
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  let crc32 = 0xffffffff;
  for (const byte of contents) {
    crc32 = (crcTable[(crc32 ^ byte) & 0xff] ^ (crc32 >>> 8)) >>> 0;
  }
  crc32 = (crc32 ^ 0xffffffff) >>> 0;

  const filenameBuf = Buffer.from(filename, 'utf-8');

  // Local file header (30 bytes + filename)
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(8, 8); // method: deflate
  localHeader.writeUInt16LE(0, 10); // mtime
  localHeader.writeUInt16LE(0, 12); // mdate
  localHeader.writeUInt32LE(crc32, 14);
  localHeader.writeUInt32LE(compressed.length, 18); // compressed size
  localHeader.writeUInt32LE(contents.length, 22); // uncompressed size
  localHeader.writeUInt16LE(filenameBuf.length, 26); // filename length
  localHeader.writeUInt16LE(0, 28); // extra length

  // Central directory file header (46 bytes + filename)
  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0); // signature
  cdHeader.writeUInt16LE(0x033f, 4); // version made by
  cdHeader.writeUInt16LE(20, 6); // version needed
  cdHeader.writeUInt16LE(0, 8); // flags
  cdHeader.writeUInt16LE(8, 10); // method
  cdHeader.writeUInt16LE(0, 12); // mtime
  cdHeader.writeUInt16LE(0, 14); // mdate
  cdHeader.writeUInt32LE(crc32, 16);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(contents.length, 24);
  cdHeader.writeUInt16LE(filenameBuf.length, 28); // filename length
  cdHeader.writeUInt16LE(0, 30); // extra length
  cdHeader.writeUInt16LE(0, 32); // comment length
  cdHeader.writeUInt16LE(0, 34); // disk number
  cdHeader.writeUInt16LE(0, 36); // internal attrs
  cdHeader.writeUInt32LE(0, 38); // external attrs
  cdHeader.writeUInt32LE(0, 42); // local header offset

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with cd
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  const cdSize = cdHeader.length + filenameBuf.length;
  const cdOffset = localHeader.length + filenameBuf.length + compressed.length;
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localHeader, filenameBuf, compressed, cdHeader, filenameBuf, eocd]);
}

/**
 * Compute the sha512 hash of a buffer in the base64 format electron-updater
 * expects inside `latest-mac.yml`'s `sha512:` field.
 */
function sha512Base64(buf) {
  return createHash('sha512').update(buf).digest('base64');
}

/**
 * Hand-craft a channel manifest (`{channel}-mac.yml`) with a single `.zip`
 * entry. Matches the shape electron-updater's Provider emits — enough fields
 * for GenericProvider to parse and enqueue the download. The `channel` field
 * is omitted for `latest` (matches electron-builder's default-channel output)
 * and present for `beta` (so a beta-channel client can verify routing).
 */
function buildMacYml({ version, channel, zipName, zipBytes, releaseDate }) {
  const sha = sha512Base64(zipBytes);
  const lines = [
    `version: ${version}`,
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${sha}`,
    `    size: ${zipBytes.length}`,
    `path: ${zipName}`,
    `sha512: ${sha}`,
    `releaseDate: '${releaseDate}'`,
  ];
  if (channel !== 'latest') {
    lines.push(`channel: ${channel}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const zipBytes = buildMinimalZip();
  const zipName = 'open-knowledge-mock.zip';
  const manifest = buildMacYml({
    version: VERSION,
    channel: CHANNEL,
    zipName,
    zipBytes,
    releaseDate: new Date().toISOString(),
  });

  // Unique request-correlation id for log noise — helps distinguish runs when
  // the harness is looped by Playwright or CI.
  const runId = randomBytes(4).toString('hex');

  /** Tracks which endpoints have been served so we know when "both served". */
  const served = { manifest: false, zip: false };

  const server = createServer((req, res) => {
    // electron-updater appends `?noCache=<random>` to every request to bypass
    // HTTP-layer caches. Strip the query string before route-matching so the
    // exact-path checks still work (and so log lines stay readable).
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?', 1)[0] ?? rawUrl;
    if (pathname === `/${MANIFEST_NAME}`) {
      res.writeHead(200, { 'Content-Type': 'application/x-yaml' });
      res.end(manifest);
      served.manifest = true;
      console.log(`[mock-updater] event=served path=/${MANIFEST_NAME} status=200 run=${runId}`);
    } else if (pathname === `/${zipName}`) {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': String(zipBytes.length),
      });
      res.end(zipBytes);
      served.zip = true;
      console.log(
        `[mock-updater] event=served path=/${zipName} status=200 bytes=${zipBytes.length} run=${runId}`,
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`not found: ${pathname}\n`);
      console.log(`[mock-updater] event=404 path=${rawUrl} run=${runId}`);
    }

    if (served.manifest && served.zip) {
      console.log(
        '[mock-updater] event=manifest-and-zip-served — Electron dev build can verify update-downloaded',
      );
      // Keep the server alive so repeat GETs during electron-updater retries
      // also succeed — but signal "primary goal reached" via stdout so any
      // orchestrator (Playwright, CI) can advance.
    }
  });

  const started = new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        console.log(`[mock-updater] port=${addr.port} run=${runId}`);
        console.log(`[mock-updater] event=start channel=${CHANNEL} version=${VERSION}`);
        console.log(`[mock-updater] feedUrl=http://127.0.0.1:${addr.port}`);
        console.log(`[mock-updater] manifestUrl=http://127.0.0.1:${addr.port}/${MANIFEST_NAME}`);
        console.log(`[mock-updater] zipUrl=http://127.0.0.1:${addr.port}/${zipName}`);
        console.log(`[mock-updater] sha512=${sha512Base64(zipBytes)}`);
        resolve(addr.port);
      } else {
        reject(new Error('server.address() returned non-object'));
      }
    });
    server.once('error', reject);
  });

  const port = await started;

  // Auto-shutdown after a successful smoke OR the configured timeout. Allows
  // tests + CI to invoke the script without hanging the pipeline.
  let shutdownReason = 'timeout';
  const timeoutHandle = setTimeout(() => {
    console.log(`[mock-updater] event=shutdown reason=${shutdownReason} port=${port}`);
    server.close(() => process.exit(shutdownReason === 'done' ? 0 : 1));
  }, TIMEOUT_MS);

  // Quick self-test: fetch /latest-mac.yml + /<zipName> against our own
  // server. Proves the HTTP plumbing works end-to-end before we sit waiting
  // for the Electron side. No electron-updater dependency.
  try {
    const base = `http://127.0.0.1:${port}`;
    const manifestResp = await fetch(`${base}/${MANIFEST_NAME}`);
    if (!manifestResp.ok) throw new Error(`manifest fetch ${manifestResp.status}`);
    const manifestText = await manifestResp.text();
    if (!manifestText.includes(`version: ${VERSION}`)) {
      throw new Error('manifest does not include expected version');
    }
    if (CHANNEL === 'beta' && !manifestText.includes('channel: beta')) {
      throw new Error('beta manifest missing `channel: beta` field');
    }
    const zipResp = await fetch(`${base}/${zipName}`);
    if (!zipResp.ok) throw new Error(`zip fetch ${zipResp.status}`);
    const zipBuf = Buffer.from(await zipResp.arrayBuffer());
    const computed = sha512Base64(zipBuf);
    const expected = sha512Base64(zipBytes);
    if (computed !== expected) throw new Error(`sha512 mismatch: ${computed} vs ${expected}`);
    console.log('[mock-updater] event=self-test-ok');
    if (KEEP_ALIVE) {
      // Manual Tier-2 flow: keep serving until Ctrl+C so the Electron dev
      // app can hit us as many times as its periodic check fires. Clear the
      // self-test timeout so we don't auto-exit; SIGINT/SIGTERM handlers
      // below take over.
      clearTimeout(timeoutHandle);
      // Write dev-app-update.yml so electron-updater's config-file
      // path (at app.getAppPath()) picks up our port. Without this, the
      // updater reads its default `publish: github` block and tries to hit
      // GitHub Releases. The dev app only needs OK_UPDATER_FORCE_DEV=1 —
      // the file itself routes traffic here.
      // For beta we set `channel: beta` so any client picking up this file
      // routes its GenericProvider to /beta-mac.yml. For latest we omit the
      // field — electron-updater's default channel is `latest`, so the
      // request goes to /latest-mac.yml without an explicit override.
      const channelLine = CHANNEL === 'latest' ? '' : `channel: ${CHANNEL}\n`;
      writeFileSync(
        DEV_APP_UPDATE_YML,
        `provider: generic\nurl: http://127.0.0.1:${port}\n${channelLine}updaterCacheDirName: open-knowledge-updater-dev\n`,
      );
      console.log(
        `[mock-updater] event=dev-config-written path=${DEV_APP_UPDATE_YML} channel=${CHANNEL}`,
      );
      console.log(
        '[mock-updater] event=keep-alive — server will stay up until Ctrl+C. Pair with: OK_UPDATER_FORCE_DEV=1 bun run --filter=@inkeep/open-knowledge-desktop dev',
      );
      return;
    }
    shutdownReason = 'done';
    clearTimeout(timeoutHandle);
    console.log(`[mock-updater] event=shutdown reason=${shutdownReason} port=${port}`);
    server.close(() => process.exit(0));
  } catch (err) {
    console.error(`[mock-updater] event=self-test-failed message=${err?.message ?? err}`);
    clearTimeout(timeoutHandle);
    server.close(() => process.exit(2));
  }

  // Graceful signal handling so `Ctrl+C` exits 0 AND cleans up the dev-
  // app-update.yml we wrote at keep-alive start. Without cleanup, a
  // stale .yml pointing at a dead port poisons future `bun run dev`
  // sessions (first `checkForUpdates()` hangs until its internal timeout).
  const handleSignal = (sig) => {
    shutdownReason = `signal-${sig}`;
    console.log(`[mock-updater] event=shutdown reason=${shutdownReason} port=${port}`);
    clearTimeout(timeoutHandle);
    if (KEEP_ALIVE && existsSync(DEV_APP_UPDATE_YML)) {
      try {
        unlinkSync(DEV_APP_UPDATE_YML);
        console.log(`[mock-updater] event=dev-config-removed path=${DEV_APP_UPDATE_YML}`);
      } catch (err) {
        console.warn(
          `[mock-updater] event=dev-config-cleanup-failed message=${err?.message ?? err}`,
        );
      }
    }
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => handleSignal('sigint'));
  process.on('SIGTERM', () => handleSignal('sigterm'));
}

main().catch((err) => {
  console.error(`[mock-updater] event=fatal message=${err?.message ?? err}`);
  process.exit(2);
});
