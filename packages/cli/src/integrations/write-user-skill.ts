import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  ALL_EDITOR_IDS,
  EDITOR_USER_SKILL_ROOT,
} from '@inkeep/open-knowledge-core';
import {
  BUNDLE_SKILL_NAME,
  detectUserSkillHosts,
  resolveBundledSkillDir,
} from '@inkeep/open-knowledge-server';
import type { EditorId } from '../commands/editors.ts';
import {
  assertAncestorsContainedIn,
  type ProjectSkillRemoveResult,
  type ProjectSkillResult,
  replaceBundleDir,
} from './write-project-skill.ts';

function userSkillPath(editor: EditorId, home: string): string | null {
  const root = EDITOR_USER_SKILL_ROOT[editor];
  return root === null
    ? null
    : join(home, ...root.split('/'), BUNDLE_SKILL_NAME.discovery, 'SKILL.md');
}

export type UserSkillWriteResult = Omit<ProjectSkillResult, 'action'> & {
  readonly action: Exclude<ProjectSkillResult['action'], 'skipped-prerequisite'>;
};

export function writeUserSkill(editor: EditorId, home: string): UserSkillWriteResult {
  const skillPath = userSkillPath(editor, home);
  if (skillPath === null) {
    return { editorId: editor, label: editor, action: 'skipped-unsupported', path: '' };
  }
  if (!detectUserSkillHosts(home).some((host) => host.editorId === editor)) {
    return { editorId: editor, label: editor, action: 'skipped-unsupported', path: skillPath };
  }
  try {
    const sourceDir = resolveBundledSkillDir('discovery', { checkDesktop: true });
    assertAncestorsContainedIn(dirname(skillPath), home);
    const action = replaceBundleDir(sourceDir, skillPath);
    return { editorId: editor, label: editor, action, path: skillPath };
  } catch (err) {
    return {
      editorId: editor,
      label: editor,
      action: 'failed',
      path: skillPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function userSkillPresentAnywhere(home: string): boolean {
  if (existsSync(join(home, ...AGENTS_SKILLS_ROOT.split('/'), BUNDLE_SKILL_NAME.discovery))) {
    return true;
  }
  return ALL_EDITOR_IDS.some((editor) => {
    const path = userSkillPath(editor, home);
    return path !== null && existsSync(dirname(path));
  });
}

export function removeUserSkill(editor: EditorId, home: string): ProjectSkillRemoveResult {
  const skillPath = userSkillPath(editor, home);
  if (skillPath === null) {
    return { editorId: editor, label: editor, action: 'skipped-unsupported', path: '' };
  }
  const targetDir = dirname(skillPath);
  try {
    if (!existsSync(skillPath)) {
      return { editorId: editor, label: editor, action: 'not-present', path: skillPath };
    }
    assertAncestorsContainedIn(targetDir, home);
    rmSync(targetDir, { recursive: true, force: true });
    return { editorId: editor, label: editor, action: 'removed', path: skillPath };
  } catch (err) {
    return {
      editorId: editor,
      label: editor,
      action: 'failed',
      path: skillPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
