import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildAgentPluginArtifact, buildSkillBundles } from '../scripts/build-skill-bundles.ts';
import { expectConformantManifest, readManifest } from './agent-plugin-manifest.test-helper.ts';
import { BUNDLE_IDS, BUNDLE_SKILL_NAME } from './skill-bundles.ts';

/**
 * Conformance guard for everything OK ships as an Agent Plugin
 * (agent-plugins.org v1.0.0). Compliance stays true by CI, not by intention:
 * every shipped manifest declares the standard's `$schema`, carries a name
 * passing the constraint grammar, and its `skills/` children (when the spec
 * layout is used) each hold a `SKILL.md`.
 *
 * Every subject must be present in every tree this file executes in — its own
 * package, a sibling workspace package, or an artifact built here. One that is
 * not will ENOENT wherever that tree lacks it.
 */

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
      // The manifest name and the pack id must agree — the reimport/update
      // path keys on the pack marker, and a divergent plugin name would split
      // one pack into two identities.
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
    // Placeholders are not allowed in `command` (spec: expansion applies to
    // args/env/cwd only) — the runner is the command, the package an arg.
    expect(server?.command).toBe('npx');
    // The Claude manifest stays — the two coexist.
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
