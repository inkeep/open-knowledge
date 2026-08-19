/** Shell argv shared by the interactive PTY and its PATH-readiness probes. */
export function interactiveShellArgs(platform: NodeJS.Platform): readonly string[] {
  return platform === 'linux' ? ['-i'] : ['-l', '-i'];
}
