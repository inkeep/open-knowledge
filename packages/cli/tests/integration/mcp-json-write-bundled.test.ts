import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const distIndex = join(import.meta.dir, '..', '..', 'dist', 'index.mjs');
const built = existsSync(distIndex);
if (!built) {
  console.warn(
    '[mcp-json-write-bundled] dist/index.mjs not built — skipping bundled-load guard. Run `bun run build:cli`.',
  );
}

interface BundledCli {
  writeEditorMcpConfig: (
    target: { configPath: () => string; [k: string]: unknown },
    cwd: string,
    options: { mode: string; skipAvailabilityCheck: boolean },
  ) => { action: string };
  EDITOR_TARGETS: Record<string, { configPath: () => string; [k: string]: unknown }>;
}

describe('surgical JSON write through the bundled CLI', () => {
  it.skipIf(!built)('loads the bundled jsonc-parser and edits only our entry', async () => {
    const mod = (await import(pathToFileURL(distIndex).href)) as unknown as BundledCli;

    const dir = mkdtempSync(join(tmpdir(), 'ok-bundled-'));
    const configPath = join(dir, 'mcp.json');
    const original = `\uFEFF{
  // user comment
  "mcpServers": {
    "existing": { "command": "node" }
  }
}
`;
    writeFileSync(configPath, original);

    const target = { ...mod.EDITOR_TARGETS.cursor, configPath: () => configPath };
    const result = mod.writeEditorMcpConfig(target, '', {
      mode: 'published',
      skipAvailabilityCheck: true,
    });

    const after = readFileSync(configPath, 'utf-8');
    try {
      expect(result.action).toBe('written');
      expect(after.charCodeAt(0)).toBe(0xfeff);
      expect(after).toContain('// user comment');
      expect(after).toContain('"existing"');
      expect(after).toContain('open-knowledge');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
