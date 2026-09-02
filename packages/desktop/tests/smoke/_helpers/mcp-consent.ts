import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function mcpStatusMarkerPath(tmpHome: string): string {
  return join(tmpHome, '.ok', 'mcp-status.json');
}

export function seedMcpConsentComplete(tmpHome: string): void {
  mkdirSync(join(tmpHome, '.ok'), { recursive: true });
  writeFileSync(
    mcpStatusMarkerPath(tmpHome),
    JSON.stringify({
      configured: true,
      configuredAt: new Date().toISOString(),
      editors: [],
      cliPath: '/usr/local/bin/ok',
    }),
  );
}
