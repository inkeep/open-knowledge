import { dirname, join, win32 } from 'node:path';

/**
 * Map a packaged executable path to the bundled `ok` CLI wrapper for that
 * platform's install layout. Pure layout arithmetic — no existence checks,
 * no packaged-install gating (that's `install-shape.ts`); this is also
 * valid for TRANSIENT uses on layouts that must not be persisted, like an
 * AppImage's live squashfs mount under /tmp — correct for spawning the CLI
 * right now, wrong to record anywhere.
 *
 * - darwin: `<Bundle>.app/Contents/MacOS/<bin>` → `Contents/Resources/cli/bin/ok.sh`
 * - win32:  `<root>\<Product>.exe` → `<root>\resources\cli\bin\ok.cmd`
 * - linux:  `<root>/<executable>` → `<root>/resources/cli/bin/ok.sh`
 */
export function wrapperPathInBundle(
  executablePath: string,
  platform: 'darwin' | 'win32' | 'linux' | string = process.platform,
): string {
  if (platform === 'win32') {
    return win32.join(win32.dirname(executablePath), 'resources', 'cli', 'bin', 'ok.cmd');
  }
  if (platform === 'linux') {
    return join(dirname(executablePath), 'resources', 'cli', 'bin', 'ok.sh');
  }
  const bundleRoot = executablePath.replace(/\/Contents\/MacOS\/.*$/, '');
  return join(bundleRoot, 'Contents', 'Resources', 'cli', 'bin', 'ok.sh');
}

/**
 * Root that every process of this app launches from, given the main
 * executable's path — the containment boundary for deciding whether a file on
 * disk belongs to us. Helper processes resolve inside it too: on darwin the
 * renderer/GPU/utility helpers live in `Contents/Frameworks/<Helper>.app`, and
 * elsewhere they sit beside the main binary.
 *
 * - darwin: `<Bundle>.app/Contents/MacOS/<bin>` → `<Bundle>.app`
 * - win32 / linux: the directory holding the executable
 *
 * Same layout arithmetic as `wrapperPathInBundle`, with no existence checks;
 * a darwin path that isn't bundle-shaped (an unpackaged binary run directly)
 * degrades to the executable's directory rather than to the filesystem root.
 */
export function appBundleRootFromExecutable(
  executablePath: string,
  platform: 'darwin' | 'win32' | 'linux' | string = process.platform,
): string {
  if (platform === 'win32') return win32.dirname(executablePath);
  if (platform === 'darwin') {
    const bundleRoot = executablePath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    if (bundleRoot !== executablePath) return bundleRoot;
  }
  return dirname(executablePath);
}
