import { describe, expect, test } from 'vitest';
import {
  ALL_EDITOR_IDS,
  EDITOR_PROJECT_CONFIG_PATH,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  HOSTS_WITH_USER_SKILL_DIR,
  HUB_READER_EDITORS,
  PROJECT_SKILL_EDITOR_IDS,
  receivesProjectIntegrationWrite,
  USER_MCP_GATED_EDITOR_IDS,
  USER_SKILL_HOSTS,
} from '../constants/editors.ts';
import { SkillTargetEditorSchema } from './schema.ts';

describe('project-skill editor-id single source', () => {
  const asStrings = (xs: readonly string[]) => xs.map(String);

  test('PROJECT_SKILL_EDITOR_IDS = exactly the editors with a non-null project-skill root', () => {
    const expected = ALL_EDITOR_IDS.filter((id) => EDITOR_PROJECT_SKILL_ROOT[id] !== null);
    expect(asStrings(PROJECT_SKILL_EDITOR_IDS)).toEqual(asStrings(expected));
  });

  test('SkillTargetEditorSchema.options is exactly PROJECT_SKILL_EDITOR_IDS (the wire enum derives from it)', () => {
    expect(asStrings(SkillTargetEditorSchema.options)).toEqual(asStrings(PROJECT_SKILL_EDITOR_IDS));
  });

  test('HOSTS_WITH_USER_SKILL_DIR derives from the same editors (CLI repair-skills ↔ desktop skill-reclaim share it)', () => {
    expect(asStrings(HOSTS_WITH_USER_SKILL_DIR.map((h) => h.editorId))).toEqual(
      asStrings(PROJECT_SKILL_EDITOR_IDS.filter((id) => id !== 'pi' && id !== 'copilot')),
    );
    for (const { hostDir, editorId } of HOSTS_WITH_USER_SKILL_DIR) {
      expect(hostDir).toBe((EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '').split('/')[0]);
      expect(hostDir.startsWith('.')).toBe(true);
    }
  });

  test('Pi IS a project-skill install target but NOT a user-global host-dir sweep member', () => {
    expect(SkillTargetEditorSchema.options).toContain('pi');
    expect(HOSTS_WITH_USER_SKILL_DIR.map((h) => h.editorId)).not.toContain('pi');
    expect(HOSTS_WITH_USER_SKILL_DIR.map((h) => h.hostDir)).not.toContain('.pi');
  });

  test('Copilot IS a project-skill install target but NOT a user-global host-dir sweep member', () => {
    expect(SkillTargetEditorSchema.options).toContain('copilot');
    expect(HOSTS_WITH_USER_SKILL_DIR.map((h) => h.editorId)).not.toContain('copilot');
    expect(HOSTS_WITH_USER_SKILL_DIR.map((h) => h.hostDir)).not.toContain('.github');
  });

  test('USER_SKILL_HOSTS preserves every concrete user-global root', () => {
    const expected = ALL_EDITOR_IDS.filter((id) => EDITOR_USER_SKILL_ROOT[id] !== null);
    expect(asStrings(USER_SKILL_HOSTS.map((host) => host.editorId))).toEqual(asStrings(expected));
    for (const { editorId, hostDir, skillsRoot } of USER_SKILL_HOSTS) {
      expect(skillsRoot).toBe(EDITOR_USER_SKILL_ROOT[editorId]);
      expect(hostDir).toBe(skillsRoot.split('/')[0]);
    }
    expect(USER_SKILL_HOSTS.find((host) => host.editorId === 'pi')?.skillsRoot).toBe(
      '.pi/agent/skills',
    );
    expect(USER_SKILL_HOSTS.find((host) => host.editorId === 'copilot')?.skillsRoot).toBe(
      '.copilot/skills',
    );
  });

  test('Claude Desktop is NOT a project-skill install target (user-global only, null root)', () => {
    expect(EDITOR_PROJECT_SKILL_ROOT['claude-desktop']).toBeNull();
    expect(SkillTargetEditorSchema.options).not.toContain('claude-desktop');
  });
});

describe('receivesProjectIntegrationWrite', () => {
  const installed = { userMcpEntryInstalled: true };
  const notInstalled = { userMcpEntryInstalled: false };

  test('an editor with a project MCP config always writes, whatever the global state', () => {
    for (const id of ['claude', 'cursor', 'codex', 'opencode', 'pi'] as const) {
      expect(EDITOR_PROJECT_CONFIG_PATH[id]).not.toBeNull();
      expect(receivesProjectIntegrationWrite(id, installed)).toBe(true);
      expect(receivesProjectIntegrationWrite(id, notInstalled)).toBe(true);
    }
  });

  test('a user-global-only editor never writes', () => {
    for (const id of [
      'claude-desktop',
      'openclaw',
      'antigravity',
      'lm-studio',
      'hermes',
    ] as const) {
      expect(receivesProjectIntegrationWrite(id, installed)).toBe(false);
      expect(receivesProjectIntegrationWrite(id, notInstalled)).toBe(false);
    }
  });

  test('Copilot writes only once its user-global entry exists', () => {
    expect(EDITOR_PROJECT_CONFIG_PATH.copilot).toBeNull();
    expect(USER_MCP_GATED_EDITOR_IDS.map(String)).toContain('copilot');
    expect(receivesProjectIntegrationWrite('copilot', notInstalled)).toBe(false);
    expect(receivesProjectIntegrationWrite('copilot', installed)).toBe(true);
  });

  test('every gated editor is skill-only — a project MCP config would make the gate moot', () => {
    for (const id of USER_MCP_GATED_EDITOR_IDS) {
      expect(EDITOR_PROJECT_CONFIG_PATH[id]).toBeNull();
      expect(EDITOR_PROJECT_SKILL_ROOT[id]).not.toBeNull();
    }
  });
});

describe('HUB_READER_EDITORS', () => {
  test('every member has a null skill root at its declared scope', () => {
    for (const { editorId, scope } of HUB_READER_EDITORS) {
      const map = scope === 'project' ? EDITOR_PROJECT_SKILL_ROOT : EDITOR_USER_SKILL_ROOT;
      expect({ editorId, scope, root: map[editorId] }).toEqual({ editorId, scope, root: null });
    }
  });

  test('a host with its own root at that scope is rejected by the rule', () => {
    for (const id of ['opencode', 'pi'] as const) {
      expect(EDITOR_PROJECT_SKILL_ROOT[id]).not.toBeNull();
      expect(HUB_READER_EDITORS.some((r) => r.editorId === id)).toBe(false);
    }
  });
});
