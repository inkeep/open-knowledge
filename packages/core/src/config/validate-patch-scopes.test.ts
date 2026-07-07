import { describe, expect, test } from 'bun:test';
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

  test('returns null for autoSync.default (project) written by a project writer', () => {
    // The committed sibling of autoSync.enabled: true/false/null are all valid
    // project-scope writes (null clears the committed default → "ask").
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
    // appearance.theme is scope: 'user'.
    const violation = validatePatchScopes({ appearance: { theme: 'dark' } }, 'project');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['appearance', 'theme']);
    expect(violation?.expectedScope).toBe('user');
    expect(violation?.actualScope).toBe('project');
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

  test('returns null for a project field written by a project writer', () => {
    // content.dir is scope: 'project'.
    expect(validatePatchScopes({ content: { dir: 'docs' } }, 'project')).toBeNull();
  });

  test('returns SCOPE_VIOLATION for a project field written by a user writer', () => {
    const violation = validatePatchScopes({ content: { dir: 'docs' } }, 'user');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.expectedScope).toBe('project');
    expect(violation?.actualScope).toBe('user');
  });

  test('null leaf still triggers scope check (clear-via-null patch)', () => {
    // Setting a project-local field to null via project writer is also a violation.
    const violation = validatePatchScopes({ autoSync: { enabled: null } }, 'project');
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    expect(violation?.path).toEqual(['autoSync', 'enabled']);
  });

  test('reports the FIRST violation only when a patch has multiple bad leaves', () => {
    // Both autoSync.enabled (project-local) and appearance.theme (user)
    // are wrong for a project writer; we surface one error.
    const violation = validatePatchScopes(
      {
        autoSync: { enabled: true },
        appearance: { theme: 'dark' },
      },
      'project',
    );
    expect(violation).not.toBeNull();
    expect(violation?.code).toBe('SCOPE_VIOLATION');
    // Iteration order is Object.entries — autoSync first.
    expect(violation?.path).toEqual(['autoSync', 'enabled']);
  });

  test('unregistered leaf (looseObject extra-key) passes through', () => {
    // The looseObject on `autoSync` admits unknown keys (e.g. legacy
    // `onboardingResolvedAt`). These have no registered scope; the
    // walker leaves them to L2 schema validation.
    expect(
      validatePatchScopes({ autoSync: { onboardingResolvedAt: '2026-05-06' } as never }, 'project'),
    ).toBeNull();
  });

  test('arrays are treated as leaf values (whole-array replacement)', () => {
    // folders: array under content. Array writers go through fine because
    // the array itself has no registered scope at this level.
    expect(validatePatchScopes({ folders: [] as never }, 'project')).toBeNull();
  });
});
