/**
 * Detect whether Claude Desktop is installed on this machine by probing
 * for its config directory.
 *
 * Claude Desktop maintains a config directory at:
 *   - macOS:   ~/Library/Application Support/Claude/
 *   - Windows: %APPDATA%/Claude/
 *   - Linux:   NOT SUPPORTED — Anthropic doesn't ship a Linux build. This
 *              helper returns false on Linux regardless of filesystem state.
 *
 * The config directory is created the first time Claude Desktop runs, so its
 * existence implies "Claude Desktop has been installed and launched at least
 * once." This is the signal `ok init` hint and the Electron
 * install-dialog gate on.
 *
 * Deliberately does NOT check for `/Applications/Claude.app` — the config dir
 * is a stronger signal. A user could delete the .app bundle without clearing
 * config state (and vice versa for rare sideload paths); the config dir tracks
 * "has Claude Desktop ever been set up here."
 *
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DetectClaudeDesktopOptions {
  /** Override `$HOME`. Defaults to `os.homedir()`. */
  home?: string;
  /** Override `process.platform`. Defaults to the running platform. */
  platformName?: NodeJS.Platform;
  /** Override process env (Windows `APPDATA` lookup). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns true when Claude Desktop's config directory exists on this machine.
 * Returns false on Linux (unsupported upstream) and when the directory is absent.
 */
export function detectClaudeDesktopPresence(opts: DetectClaudeDesktopOptions = {}): boolean {
  const home = opts.home ?? homedir();
  const platformName = opts.platformName ?? process.platform;
  const env = opts.env ?? process.env;

  if (platformName === 'darwin') {
    return existsSync(join(home, 'Library', 'Application Support', 'Claude'));
  }

  if (platformName === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return existsSync(join(appData, 'Claude'));
  }

  // Linux + anything else: no Claude Desktop build exists upstream.
  return false;
}
