import { describe, expect, test, vi } from 'vitest';

describe('EditorActivityPool source lazy boundary', () => {
  test('does not import SourceEditor until the lazy loader runs', async () => {
    let sourceEditorModuleLoads = 0;

    vi.doMock('@/editor/SourceEditor', () => {
      sourceEditorModuleLoads += 1;
      return {
        SourceEditor: () => null,
      };
    });

    const mod = await import('./EditorActivityPool');

    expect(typeof mod.EditorActivityPool).toBe('function');
    expect(sourceEditorModuleLoads).toBe(0);

    const sourceEditorModule = await mod.loadSourceEditorModule();
    expect(typeof sourceEditorModule.SourceEditor).toBe('function');
    expect(sourceEditorModuleLoads).toBe(1);
  });
});
