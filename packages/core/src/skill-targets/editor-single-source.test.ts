/**
 * Drift guard for the project-skill editor-id single source.
 *
 * The editor ids a project skill installs into must have ONE source:
 * `EDITOR_PROJECT_SKILL_ROOT` (an editor is a valid target iff its root is
 * non-null) → `PROJECT_SKILL_EDITOR_IDS` (the runtime filter) →
 * `SkillTargetEditorSchema` (the wire/MCP enum, whose `.options` the install
 * verb, the `SkillEditorActions` install menu, and the `SkillTargetsPicker` all
 * consume). If anyone re-hardcodes the list or the chain desyncs, this fails.
 *
 * This is the "add a 4th editor and it flows through everywhere" guard: adding
 * an editor with a non-null `EDITOR_PROJECT_SKILL_ROOT` automatically appears in
 * all three derived surfaces with no other code change, and these assertions
 * prove the derivation rather than a duplicated literal.
 */

import { describe, expect, test } from 'bun:test';
import {
  ALL_EDITOR_IDS,
  EDITOR_PROJECT_SKILL_ROOT,
  HOSTS_WITH_USER_SKILL_DIR,
  PROJECT_SKILL_EDITOR_IDS,
} from '../constants/editors.ts';
import { SkillTargetEditorSchema } from './schema.ts';

describe('project-skill editor-id single source', () => {
  // Compare as plain strings — `.filter()` widens the element type back to
  // EditorId, so a typed `.toEqual` trips variance; the value identity is what
  // matters here.
  const asStrings = (xs: readonly string[]) => xs.map(String);

  test('PROJECT_SKILL_EDITOR_IDS = exactly the editors with a non-null project-skill root', () => {
    const expected = ALL_EDITOR_IDS.filter((id) => EDITOR_PROJECT_SKILL_ROOT[id] !== null);
    expect(asStrings(PROJECT_SKILL_EDITOR_IDS)).toEqual(asStrings(expected));
  });

  test('SkillTargetEditorSchema.options is exactly PROJECT_SKILL_EDITOR_IDS (the wire enum derives from it)', () => {
    expect(asStrings(SkillTargetEditorSchema.options)).toEqual(asStrings(PROJECT_SKILL_EDITOR_IDS));
  });

  test('HOSTS_WITH_USER_SKILL_DIR derives from the same editors (CLI repair-skills ↔ desktop skill-reclaim share it)', () => {
    // Single source for the host-dir sweep both the CLI and desktop run. editorId
    // set === PROJECT_SKILL_EDITOR_IDS; hostDir === the root's top-level dotdir.
    expect(asStrings(HOSTS_WITH_USER_SKILL_DIR.map((h) => h.editorId))).toEqual(
      asStrings(PROJECT_SKILL_EDITOR_IDS),
    );
    for (const { hostDir, editorId } of HOSTS_WITH_USER_SKILL_DIR) {
      expect(hostDir).toBe((EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '').split('/')[0]);
      expect(hostDir.startsWith('.')).toBe(true);
    }
  });

  test('Claude Desktop is NOT a project-skill install target (user-global only, null root)', () => {
    // Regression: the install menu / picker must not offer claude-desktop —
    // it has no project skill surface (reads user-global skills only).
    expect(EDITOR_PROJECT_SKILL_ROOT['claude-desktop']).toBeNull();
    expect(SkillTargetEditorSchema.options).not.toContain('claude-desktop');
  });
});
