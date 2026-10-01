import { describe, expect, test, vi } from 'vitest';
import { EditorActivityPool, loadSourceEditorModule } from './EditorActivityPool';

const sourceEditorModuleLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/editor/SourceEditor', () => {
  sourceEditorModuleLoads.count += 1;
  return {
    SourceEditor: () => null,
  };
});

describe('EditorActivityPool source lazy boundary', () => {
  test('does not import SourceEditor until the lazy loader runs', async () => {
    expect(typeof EditorActivityPool).toBe('function');
    expect(sourceEditorModuleLoads.count).toBe(0);

    const sourceEditorModule = await loadSourceEditorModule();
    expect(typeof sourceEditorModule.SourceEditor).toBe('function');
    expect(sourceEditorModuleLoads.count).toBe(1);
  });
});
