#!/usr/bin/env node

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
const DEFAULT_VERSION = CHANNEL === 'beta' ? '0.4.0-beta.0' : '0.99.0-mock';
const VERSION = process.env.MOCK_UPDATE_VERSION ?? DEFAULT_VERSION;
const TIMEOUT_MS = Number.parseInt(process.env.MOCK_UPDATE_TIMEOUT_MS ?? '30000', 10);
const KEEP_ALIVE = process.argv.includes('--keep-alive');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(__dirname, '..');
const DEV_APP_UPDATE_YML = resolve(DESKTOP_ROOT, 'dev-app-update.yml');

function buildMinimalZip() {
  const filename = 'payload.txt';
  const contents = Buffer.from(
    `OpenKnowledge M3 mock update payload\nversion=${VERSION}\ntimestamp=${new Date().toISOString()}\n`,
    'utf-8',
  );
  const compressed = deflateRawSync(contents);
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

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc32, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(contents.length, 22);
  localHeader.writeUInt16LE(filenameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(0x033f, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0, 8);
  cdHeader.writeUInt16LE(8, 10);
  cdHeader.writeUInt16LE(0, 12);
  cdHeader.writeUInt16LE(0, 14);
  cdHeader.writeUInt32LE(crc32, 16);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(contents.length, 24);
  cdHeader.writeUInt16LE(filenameBuf.length, 28);
  cdHeader.writeUInt16LE(0, 30);
  cdHeader.writeUInt16LE(0, 32);
  cdHeader.writeUInt16LE(0, 34);
  cdHeader.writeUInt16LE(0, 36);
  cdHeader.writeUInt32LE(0, 38);
  cdHeader.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  const cdSize = cdHeader.length + filenameBuf.length;
  const cdOffset = localHeader.length + filenameBuf.length + compressed.length;
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, filenameBuf, compressed, cdHeader, filenameBuf, eocd]);
}

function sha512Base64(buf) {
  return createHash('sha512').update(buf).digest('base64');
}

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

  const runId = randomBytes(4).toString('hex');

  const served = { manifest: false, zip: false };

  const server = createServer((req, res) => {
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

  let shutdownReason = 'timeout';
  const timeoutHandle = setTimeout(() => {
    console.log(`[mock-updater] event=shutdown reason=${shutdownReason} port=${port}`);
    server.close(() => process.exit(shutdownReason === 'done' ? 0 : 1));
  }, TIMEOUT_MS);

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
      clearTimeout(timeoutHandle);
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
