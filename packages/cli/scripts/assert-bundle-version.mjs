import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const BUNDLE_DIR = 'dist/public';
export const VERSION_KEY = 'VITE_APP_VERSION';
export const RECOVERY_SECTION = 'The four release.yml jobs and their credentials';

const BAKED_VERSION = /\bVITE_APP_VERSION["'`]?\s*:\s*(["'`])([^"'`]*)\1/g;

export function bakedVersions(source) {
  return Array.from(source.matchAll(BAKED_VERSION), (match) => match[2]);
}

export function readBundle(packageDir) {
  const { name, version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const bundleDir = join(packageDir, BUNDLE_DIR);
  const scripts = readdirSync(bundleDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const baked = new Map();
  for (const file of scripts) {
    for (const value of new Set(bakedVersions(readFileSync(file, 'utf8')))) {
      baked.set(value, [...(baked.get(value) ?? []), relative(packageDir, file)]);
    }
  }
  return { name, version, scripts: scripts.length, baked };
}

export function judgeBundle({ name, version, scripts, baked }) {
  if (typeof version !== 'string' || version === '') {
    return [
      `${name ?? 'the package'} has no version in its package.json, so there is nothing to compare ${BUNDLE_DIR} against`,
    ];
  }
  if (scripts === 0) {
    return [
      `${BUNDLE_DIR} holds no scripts, so the app's build output never reached the cli; build the app before the cli copies it`,
    ];
  }
  if (baked.size === 0) {
    return [
      `none of the ${scripts} scripts in ${BUNDLE_DIR} carries a ${VERSION_KEY} literal, so the version its browser bundle reports cannot be checked against ${name}@${version}. If the app build changed how it inlines import.meta.env, teach bakedVersions in packages/cli/scripts/assert-bundle-version.mjs the new form`,
    ];
  }
  return [...baked]
    .filter(([value]) => value !== version)
    .map(
      ([value, files]) =>
        `${BUNDLE_DIR} was built for ${value} (${files.join(', ')}), but this is ${name}@${version}, so its browser bundle would send x-ok-client-runtime ${value}. The app was built before the version override; build it after the override`,
    );
}

function refuse(errors) {
  for (const error of errors) console.log(`::error::bundle-version: ${error}`);
  console.log(
    `::error::bundle-version: nothing was packed. Fix the cause on main, then resume per RELEASES.md '${RECOVERY_SECTION}'.`,
  );
  return 1;
}

export function main(argv = process.argv.slice(2)) {
  const [packageDir, ...rest] = argv;
  if (!packageDir || rest.length > 0) {
    console.log('::error::bundle-version: usage: assert-bundle-version.mjs <package-dir>');
    return 1;
  }
  let bundle;
  try {
    bundle = readBundle(packageDir);
  } catch (error) {
    return refuse([`cannot read ${packageDir}: ${error.message}`]);
  }
  const errors = judgeBundle(bundle);
  if (errors.length > 0) return refuse(errors);
  console.log(
    `bundle-version ok: ${bundle.baked.get(bundle.version).length} of ${bundle.scripts} scripts in ${BUNDLE_DIR} bake ${VERSION_KEY} ${bundle.version}, the version of ${bundle.name}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
