import { describe, expect, it } from 'vitest';
import { CENTRAL_SKILL_STORE_PATH_ID, editorPathId, parsePathId } from './paths.ts';

describe('path ids', () => {
  it('round-trips an editor-keyed location back into the map to look it up in', () => {
    expect(parsePathId(editorPathId('editor-project-config', 'claude'))).toEqual({
      kind: 'editor-project-config',
      editor: 'claude',
    });
    expect(parsePathId(editorPathId('editor-user-skill-root', 'pi'))).toEqual({
      kind: 'editor-user-skill-root',
      editor: 'pi',
    });
  });

  it('reads the shared hub, which belongs to no editor', () => {
    expect(parsePathId(CENTRAL_SKILL_STORE_PATH_ID)).toEqual({ kind: 'central-skill-store' });
  });

  it('refuses anything this build cannot resolve, rather than handing back a lookup that misses', () => {
    expect(parsePathId('editor-user-config:not-an-editor')).toBeNull();
    expect(parsePathId('editor-user-config:')).toBeNull();
    expect(parsePathId('some-other-family:claude')).toBeNull();
    expect(parsePathId('no-separator')).toBeNull();
  });

  it('names a location instead of spelling one', () => {
    expect(editorPathId('editor-project-skill-root', 'codex')).not.toMatch(/^[/~]/);
  });
});
