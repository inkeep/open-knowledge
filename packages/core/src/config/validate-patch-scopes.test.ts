import { describe, expect, test } from 'vitest';
import { validatePatchScopes } from './validate-patch-scopes.ts';

describe('validatePatchScopes', () => {
  test('returns null for an empty patch', () => {
    expect(validatePatchScopes({}, 'project-local')).toBeNull();
    expect(validatePatchScopes({}, 'project')).toBeNull();
    expect(validatePatchScopes({}, 'user')).toBeNull();
  });

  test('returns null for a project-local field written by a project-local writer', () => {
    expect(validatePatchScopes({ autoSync: { enabled: true } }, 'project-local')).toBeNull();
  });

  test('returns SCOPE_VIOLATION for a project-local field written by a project writer', () => {
    const violation = validatePatchScopes({ autoSync: { enabled: true } }, 'project');
    expect(violation).not.toBeNull();
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['autoSync', 'enabled']);
    expect(violation?.expectedScope).toBe('project-local');
    expect(violation?.actualScope).toBe('project');
  });

  test('returns SCOPE_VIOLATION for a project-local field written by a user writer', () => {
    const violation = validatePatchScopes({ autoSync: { enabled: false } }, 'user');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.expectedScope).toBe('project-local');
    expect(violation?.actualScope).toBe('user');
  });

  test('returns null for the sidebar view toggles written by a project-local writer', () => {
    expect(
      validatePatchScopes(
        {
          appearance: {
            sidebar: {
              showOnlyMarkdownFiles: true,
              showSkillsSection: false,
              showOkFolders: true,
            },
          },
        },
        'project-local',
      ),
    ).toBeNull();
  });

  test('returns SCOPE_VIOLATION for a sidebar view toggle written by a project writer', () => {
    const violation = validatePatchScopes(
      { appearance: { sidebar: { showOnlyMarkdownFiles: true } } },
      'project',
    );
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['appearance', 'sidebar', 'showOnlyMarkdownFiles']);
    expect(violation?.expectedScope).toBe('project-local');
    expect(violation?.actualScope).toBe('project');
  });

  test('returns null for autoSync.default (project) written by a project writer', () => {
    expect(validatePatchScopes({ autoSync: { default: false } }, 'project')).toBeNull();
    expect(validatePatchScopes({ autoSync: { default: true } }, 'project')).toBeNull();
    expect(validatePatchScopes({ autoSync: { default: null } }, 'project')).toBeNull();
  });

  test('returns SCOPE_VIOLATION for autoSync.default written by a project-local writer', () => {
    const violation = validatePatchScopes({ autoSync: { default: false } }, 'project-local');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['autoSync', 'default']);
    expect(violation?.expectedScope).toBe('project');
    expect(violation?.actualScope).toBe('project-local');
  });

  test('returns SCOPE_VIOLATION for autoSync.default written by a user writer', () => {
    const violation = validatePatchScopes({ autoSync: { default: true } }, 'user');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.expectedScope).toBe('project');
    expect(violation?.actualScope).toBe('user');
  });

  test('returns SCOPE_VIOLATION for a user field written by a project writer', () => {
    const violation = validatePatchScopes({ appearance: { theme: 'dark' } }, 'project');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['appearance', 'theme']);
    expect(violation?.expectedScope).toBe('user');
    expect(violation?.actualScope).toBe('project');
  });

  test('returns SCOPE_VIOLATION for appearance.language written by a project writer', () => {
    const violation = validatePatchScopes({ appearance: { language: 'es' } }, 'project');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['appearance', 'language']);
    expect(violation?.expectedScope).toBe('user');
    expect(violation?.actualScope).toBe('project');
  });

  test('accepts appearance.language written by a user writer', () => {
    expect(validatePatchScopes({ appearance: { language: 'zh-Hans' } }, 'user')).toBeNull();
  });

  test('returns SCOPE_VIOLATION for a user field written by a project-local writer', () => {
    const violation = validatePatchScopes({ appearance: { theme: 'light' } }, 'project-local');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.expectedScope).toBe('user');
    expect(violation?.actualScope).toBe('project-local');
  });

  test('returns null for editor.wordWrap written by a user writer', () => {
    expect(validatePatchScopes({ editor: { wordWrap: false } }, 'user')).toBeNull();
  });

  test('accepts editor.previewTabs only from a user writer', () => {
    expect(validatePatchScopes({ editor: { previewTabs: false } }, 'user')).toBeNull();

    const projectViolation = validatePatchScopes({ editor: { previewTabs: false } }, 'project');
    expect(projectViolation?.code).toBe('SCOPE_VIOLATION');
    expect(projectViolation?.path).toEqual(['editor', 'previewTabs']);

    const projectLocalViolation = validatePatchScopes(
      { editor: { previewTabs: false } },
      'project-local',
    );
    expect(projectLocalViolation?.code).toBe('SCOPE_VIOLATION');
    expect(projectLocalViolation?.path).toEqual(['editor', 'previewTabs']);
  });

  test('returns null for a project field written by a project writer', () => {
    expect(validatePatchScopes({ content: { dir: 'docs' } }, 'project')).toBeNull();
  });

  test('returns SCOPE_VIOLATION for a project field written by a user writer', () => {
    const violation = validatePatchScopes({ content: { dir: 'docs' } }, 'user');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.expectedScope).toBe('project');
    expect(violation?.actualScope).toBe('user');
  });

  test('null leaf still triggers scope check (clear-via-null patch)', () => {
    const violation = validatePatchScopes({ autoSync: { enabled: null } }, 'project');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['autoSync', 'enabled']);
  });

  test('reports the FIRST violation only when a patch has multiple bad leaves', () => {
    const violation = validatePatchScopes(
      {
        autoSync: { enabled: true },
        appearance: { theme: 'dark' },
      },
      'project',
    );
    expect(violation).not.toBeNull();
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['autoSync', 'enabled']);
  });

  test('unregistered leaf (looseObject extra-key) passes through', () => {
    expect(
      validatePatchScopes({ autoSync: { onboardingResolvedAt: '2026-05-06' } as never }, 'project'),
    ).toBeNull();
  });

  test('arrays are treated as leaf values (whole-array replacement)', () => {
    expect(validatePatchScopes({ folders: [] as never }, 'project')).toBeNull();
  });
});
