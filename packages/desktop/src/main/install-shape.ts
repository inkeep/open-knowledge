/**
 * Per-platform packaged-install shape classification (windows-linux-port
 * spec, Tier B). Every user-machine reclaim surface (PATH install, MCP
 * wiring, skill reclaim, project MCP reclaim, integrations settings) gates
 * on "is this executable a supported packaged install, and where do its
 * bundled CLI resources live?" — historically a darwin-only
 * `.app/Contents/MacOS` regex. This module is the single cross-platform
 * answer, so the gates can't drift from each other.
 *
 * Shapes:
 * - darwin: `<Bundle>.app/Contents/MacOS/<bin>` → resources under
 *   `Contents/Resources`.
 * - win32: `<installRoot>\<Product>.exe` → resources under
 *   `<installRoot>\resources` (electron-builder NSIS layout; per-user
 *   default `%LOCALAPPDATA%\Programs\@inkeepopen-knowledge-desktop` — the
 *   sanitized package name; electron-builder only tries productName for
 *   assisted/per-machine installs).
 * - linux (deb / unpacked dir): `<installRoot>/<executable>` → resources
 *   under `<installRoot>/resources` (`/opt/OpenKnowledge` for deb).
 * - linux AppImage: the squashfs mount path in `process.execPath` dies with
 *   the process and relocates every launch, so anything that would persist
 *   a path into user config (PATH symlinks, MCP entries, wrapper paths)
 *   must DECLINE — a recorded mount path is guaranteed-dead config. The
 *   `APPIMAGE` env var (exported by the AppImage runtime) is the signal.
 */

import { dirname, win32 } from 'node:path';
import { wrapperPathInBundle } from './bundle-paths.ts';

export type InstallShape =
  | { kind: 'mac-bundle'; wrapperPath: string }
  | { kind: 'windows'; installRoot: string; wrapperPath: string }
  | { kind: 'linux'; installRoot: string; wrapperPath: string }
  /** Packaged Linux AppImage — ephemeral mount path; persistent-path integrations decline. */
  | { kind: 'appimage' }
  /** Executable path matches no supported packaged layout (dev shells, odd relocations). */
  | { kind: 'unsupported' };

export function classifyInstallShape(
  platform: 'darwin' | 'win32' | 'linux' | string,
  executablePath: string,
  env: Record<string, string | undefined>,
): InstallShape {
  if (platform === 'darwin') {
    if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) return { kind: 'unsupported' };
    return {
      kind: 'mac-bundle',
      wrapperPath: wrapperPathInBundle(executablePath, platform),
    };
  }
  if (platform === 'win32') {
    if (!/\.exe$/i.test(executablePath)) return { kind: 'unsupported' };
    return {
      kind: 'windows',
      installRoot: win32.dirname(executablePath),
      wrapperPath: wrapperPathInBundle(executablePath, platform),
    };
  }
  if (platform === 'linux') {
    if (env.APPIMAGE) return { kind: 'appimage' };
    if (!executablePath.startsWith('/')) return { kind: 'unsupported' };
    return {
      kind: 'linux',
      installRoot: dirname(executablePath),
      wrapperPath: wrapperPathInBundle(executablePath, platform),
    };
  }
  return { kind: 'unsupported' };
}
