import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { smokeDesktopProduct } from './desktop-product.ts';

export function mcpStatusMarkerPath(tmpHome: string): string {
  return join(tmpHome, smokeDesktopProduct().userHomeDirName, 'mcp-status.json');
}

export function seedMcpConsentComplete(tmpHome: string): void {
  mkdirSync(dirname(mcpStatusMarkerPath(tmpHome)), { recursive: true });
  writeFileSync(
    mcpStatusMarkerPath(tmpHome),
    JSON.stringify({
      configured: true,
      configuredAt: new Date().toISOString(),
      editors: [],
    }),
  );
}
