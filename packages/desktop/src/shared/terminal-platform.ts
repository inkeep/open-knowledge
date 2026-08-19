export function isTerminalPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}
