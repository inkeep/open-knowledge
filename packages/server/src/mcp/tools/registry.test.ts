/**
 * Registry assertion — pins the 17-tool surface of `registerAllTools`.
 *
 * The OK MCP redesign collapsed the original surface to 17 native
 * CRUD verbs + discriminated reads:
 *   - `write` / `edit` / `delete` / `move` are polymorphic over
 *     document / folder / template / asset — absorbing write_document,
 *     edit_document, edit_frontmatter, delete_document, rename(_document/_folder),
 *     set_folder_rule, write_template, delete_template, and folder_config.
 *   - `links` (read) absorbed the 6 link-graph getters.
 *   - `checkpoint` + `restore_version` replaced save_version + rollback_to_version
 *     (the interim single `version` tool was split).
 *   - `conflicts` absorbed list_conflicts + get_conflict_content.
 *   - `palette` absorbed get_components + get_authoring_palette.
 *   - `workflow({ kind })` absorbed ingest / research / consolidate / discover.
 *   - `history` / `config` / `preview_url` dropped the `get_` prefix.
 *   - read_document / grep / list_documents were dropped (exec subsumes).
 *
 * This test guards both ends: the 17 retained tools are present; none of the
 * names in RETIRED_TOOL_NAMES are.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { registerAllTools } from './index.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

const EXPECTED_TOOLS = [
  // Reads
  'exec',
  'search',
  'history',
  'links',
  'skills',
  'config',
  'palette',
  'preview_url',
  'share_link',
  // Writes — CRUD verbs + version
  'write',
  'edit',
  'delete',
  'move',
  // Skill install-projection — the one new verb beyond the CRUD set.
  'install',
  'checkpoint',
  'restore_version',
  // GitHub-sync conflicts
  'conflicts',
  'resolve_conflict',
  // Workflow
  'workflow',
] as const;

const RETIRED_TOOL_NAMES = [
  // Link-graph getters → links
  'get_backlinks',
  'get_forward_links',
  'get_dead_links',
  'get_orphans',
  'get_hubs',
  'suggest_links',
  // Rename → rename
  'rename_document',
  'rename_folder',
  // Versioning writes → checkpoint + restore_version
  'save_version',
  'rollback_to_version',
  'version',
  // Folder-config writes → folder_config
  'set_folder_rule',
  'write_template',
  'delete_template',
  // Frontmatter patch → edit_frontmatter
  'frontmatter_patch',
  // CRUD-verb consolidation → write / edit / delete / move
  'write_document',
  'edit_document',
  'edit_frontmatter',
  'delete_document',
  'rename',
  'folder_config',
  // Typed reads → exec
  'read_document',
  'grep',
  'list_documents',
  // Components/palette merge → palette({ components? })
  'get_components',
  'get_authoring_palette',
  // Workflow primers → workflow({ kind })
  'ingest',
  'research',
  'consolidate',
  'discover',
  // get_ prefix drops → history / config / preview_url
  'get_history',
  'get_config',
  'get_preview_url',
] as const;

function captureRegistered(): string[] {
  const names: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'ok-registry-assertion-'));
  const server = {
    registerTool(name: string, _cfg: unknown, _handler: unknown) {
      names.push(name);
    },
    tool() {
      throw new Error('legacy tool() API not expected — every tool must use registerTool');
    },
  } as unknown as ServerInstance;
  registerAllTools(server, {
    config: BASE_CONFIG,
    resolveCwd: async () => cwd,
    serverUrl: undefined,
  });
  return names;
}

describe('registerAllTools — 19-tool surface (SPEC.md §9.1 / AC8 + PRD-6935 install + skills read)', () => {
  test('registers exactly 19 tools', () => {
    const names = captureRegistered();
    expect(names.length).toBe(19);
  });

  test('the 19 expected tool names are all present', () => {
    const names = new Set(captureRegistered());
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
  });

  test('none of the 17 pre-consolidation tool names are registered', () => {
    const names = new Set(captureRegistered());
    for (const retired of RETIRED_TOOL_NAMES) {
      expect(names.has(retired)).toBe(false);
    }
  });

  test('the registered set matches the expected set exactly (no extras)', () => {
    const names = new Set(captureRegistered());
    expect(names).toEqual(new Set(EXPECTED_TOOLS));
  });

  test('no duplicate registrations', () => {
    const names = captureRegistered();
    expect(names.length).toBe(new Set(names).size);
  });
});
