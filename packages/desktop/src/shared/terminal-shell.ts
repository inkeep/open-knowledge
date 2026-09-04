export function interactiveShellArgs(platform: NodeJS.Platform): readonly string[] {
  return platform === 'linux' ? ['-i'] : ['-l', '-i'];
}
