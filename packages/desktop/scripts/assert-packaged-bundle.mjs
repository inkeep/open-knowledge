import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { listAsarHeaderPaths, readAsarHeader } from './lib/asar-header.mjs';

export const FORBIDDEN_BUNDLE_PATHS = [
  {
    pattern: /(^|\/)CACHEDIR\.TAG$/,
    reason: 'a build cache directory (a Rust cargo `target/` tree)',
  },
  {
    pattern: /^app\.asar\/(?!(out|node_modules)(\/|$)|package\.json$)/,
    reason: 'desktop package files outside out/, node_modules/ and package.json',
  },
  {
    pattern: /^app\.asar\/out\/renderer\//,
    reason: "electron-vite's renderer build, which only unpackaged runs load",
  },
  {
    pattern:
      /^(cli\/dist|app\.asar(\.unpacked)?\/node_modules\/@inkeep\/open-knowledge\/dist)\/public\//,
    reason: 'a second copy of the web app; Resources/app is the only one',
  },
  {
    pattern: /^app\.asar(\.unpacked)?\/node_modules\/@inkeep\/open-knowledge-native-config\//,
    reason: 'a native-config package in the asar; the CLI loads its own dist/native copy',
  },
  {
    pattern: /^app\.asar(\.unpacked)?\/node_modules\/@inkeep\/[^/]+\/src\//,
    reason: 'workspace TypeScript sources, which no packaged process loads',
  },
];

export const REQUIRED_BUNDLE_PATHS = [
  {
    pattern: /^app\.asar\/package\.json$/,
    reason: 'app.asar with its package.json',
  },
  {
    pattern:
      /^app\.asar\.unpacked\/node_modules\/@inkeep\/open-knowledge\/dist\/native\/index\.js$/,
    reason: "the main process's native-config loader, unpacked",
  },
  {
    pattern:
      /^app\.asar\.unpacked\/node_modules\/@inkeep\/open-knowledge\/dist\/native\/[^/]+\.node$/,
    reason: "the main process's native-config addon, unpacked",
  },
  {
    pattern: /^cli\/dist\/native\/index\.js$/,
    reason: "the bundled CLI's native-config loader",
  },
  {
    pattern: /^cli\/dist\/native\/[^/]+\.node$/,
    reason: "the bundled CLI's native-config addon",
  },
];

export function findForbiddenBundlePaths(paths) {
  return FORBIDDEN_BUNDLE_PATHS.flatMap(({ pattern, reason }) => {
    const hits = paths.filter((p) => pattern.test(p));
    return hits.length === 0 ? [] : [{ reason, count: hits.length, example: hits[0] }];
  });
}

export function findMissingBundlePaths(paths) {
  return REQUIRED_BUNDLE_PATHS.filter(({ pattern }) => !paths.some((p) => pattern.test(p))).map(
    ({ reason }) => reason,
  );
}

function walk(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, root, out);
    else out.push(relative(root, abs).split(sep).join('/'));
  }
  return out;
}

export function listBundlePaths(resourcesDir) {
  const asarPath = join(resourcesDir, 'app.asar');
  const onDisk = walk(resourcesDir, resourcesDir, []).filter((p) => p !== 'app.asar');
  const inAsar = existsSync(asarPath)
    ? listAsarHeaderPaths(readAsarHeader(asarPath)).map((p) => `app.asar/${p}`)
    : [];
  return [...onDisk, ...inAsar];
}

export function assertPackagedBundle(resourcesDir) {
  const paths = listBundlePaths(resourcesDir);
  const problems = [
    ...findForbiddenBundlePaths(paths).map(
      (v) => `  - carries ${v.reason}: ${v.count} path(s), e.g. Resources/${v.example}`,
    ),
    ...findMissingBundlePaths(paths).map((reason) => `  - lacks ${reason}`),
  ];
  if (problems.length === 0) return;
  throw new Error(
    `[afterPack] the packaged app's Resources/ is not laid out the way its processes load it:\n${problems.join('\n')}\n` +
      'Fix the `files` / `extraResources` / `asarUnpack` rules in electron-builder.yml.',
  );
}
