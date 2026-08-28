import { closeSync, openSync, readSync } from 'node:fs';

/** Prevent a corrupt prefix from allocating an attacker-sized buffer. */
export const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024;

/** Read and parse the bounded JSON directory header from an Electron asar. */
export function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) < 16) {
      throw new Error('file is shorter than the 16-byte asar header prefix');
    }
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize === 0 || jsonSize > MAX_ASAR_HEADER_BYTES) {
      throw new Error(
        `implausible asar header length (${jsonSize} bytes) — file is not a valid asar`,
      );
    }
    const json = Buffer.alloc(jsonSize);
    if (readSync(fd, json, 0, jsonSize, 16) < jsonSize) {
      throw new Error(`asar header truncated (wanted ${jsonSize} bytes)`);
    }
    return JSON.parse(json.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}
