import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// UPSTREAM(electron@44.5.1, electron-updater@6.8.4): Electron 44 requires macOS 13, which `os.release()` reports as Darwin 22; electron-updater skips a manifest whose `minimumSystemVersion` is above that value.
export const MAC_UPDATE_MINIMUM_DARWIN_VERSION = '22.0.0';

export function withMacMinimumSystemVersion(
  manifest: string,
  version: string = MAC_UPDATE_MINIMUM_DARWIN_VERSION,
): string {
  const parsed: unknown = parseYaml(manifest);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The macOS update manifest is not a YAML mapping');
  }
  if ('minimumSystemVersion' in parsed) {
    if (parsed.minimumSystemVersion === version) return manifest;
    throw new Error(
      `The macOS update manifest already requires ${String(parsed.minimumSystemVersion)}, not ${version}`,
    );
  }
  const stamped = `${manifest.endsWith('\n') ? manifest : `${manifest}\n`}minimumSystemVersion: '${version}'\n`;
  const reparsed = parseYaml(stamped) as { minimumSystemVersion?: unknown };
  if (reparsed.minimumSystemVersion !== version) {
    throw new Error(`The macOS update manifest did not keep minimumSystemVersion ${version}`);
  }
  return stamped;
}

export function stampMacUpdateManifests(outputDir: string): string[] {
  const names = existsSync(outputDir)
    ? readdirSync(outputDir).filter((name) => name.endsWith('-mac.yml'))
    : [];
  if (names.length === 0) {
    throw new Error(`electron-builder wrote no macOS update manifest to ${outputDir}`);
  }
  for (const name of names) {
    const path = join(outputDir, name);
    try {
      writeFileSync(path, withMacMinimumSystemVersion(readFileSync(path, 'utf8')));
    } catch (err) {
      throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }
  return names;
}
