export function harnessScenarioTitles(platform: NodeJS.Platform): readonly string[] {
  return [
    'real command round-trip at project root',
    'strips desktop env markers from the shell',
    ...(platform === 'win32' ? ['PowerShell executes a structured launch command'] : []),
    'host survives a PTY death and respawns',
    'bad shell surfaces as a spawn failure',
  ];
}
