#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const CACHE_KEY_FILE = 'turbo-cache-key.json';

export function cacheKey({ platform, arch } = process) {
  return { platform, arch };
}

export function writeCacheKey(root = OK_ROOT, proc = process) {
  const key = cacheKey(proc);
  const path = join(root, CACHE_KEY_FILE);
  writeFileSync(path, `${JSON.stringify(key)}\n`);
  return { path, key };
}

if (import.meta.main) {
  const { path, key } = writeCacheKey();
  console.log(`turbo cache key ${JSON.stringify(key)} -> ${path}`);
}
