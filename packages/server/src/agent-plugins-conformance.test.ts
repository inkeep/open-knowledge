import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildAgentPluginArtifact, buildSkillBundles } from '../scripts/build-skill-bundles.ts';
import { expectConformantManifest, readManifest } from './agent-plugin-manifest.test-helper.ts';
import { BUNDLE_IDS, BUNDLE_SKILL_NAME } from './skill-bundles.ts';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_OK_ROOT = join(PKG_ROOT, '..', '..');

describe('shipped Agent Plugins conformance', () => {
  test('every starter pack carries a conformant manifest matching its dir name', () => {
    const packsDir = join(PKG_ROOT, 'assets', 'skills', 'packs');
    const packs = readdirSync(packsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const dir = join(packsDir, pack.name);
      expectConformantManifest(dir);
      expect(readManifest(dir).name, `${pack.name} name`).toBe(pack.name);
    }
  });

  test('the OK MCP plugin ships the spec manifest pair beside its Claude one', () => {
    const dir = join(REPO_OK_ROOT, 'packages', 'plugin');
    expectConformantManifest(dir);
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf-8')) as {
      $schema?: unknown;
      mcpServers?: Record<string, { type?: unknown; command?: unknown }>;
    };
    expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    const server = mcp.mcpServers?.['open-knowledge'];
    expect(server?.type).toBe('stdio');
    expect(server?.command).toBe('npx');
    expect(existsSync(join(dir, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  test('the composed built-ins artifact is a conformant plugin with real skill names', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ok-agent-plugin-artifact-'));
    try {
      const paths = {
        skillsDir: join(PKG_ROOT, 'assets', 'skills'),
        distDir: join(scratch, 'skills'),
      };
      buildSkillBundles(paths);
      const outRoot = buildAgentPluginArtifact(paths);
      expectConformantManifest(outRoot);
      for (const bundle of BUNDLE_IDS) {
        const name = BUNDLE_SKILL_NAME[bundle];
        expect(existsSync(join(outRoot, 'skills', name, 'SKILL.md')), name).toBe(true);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
