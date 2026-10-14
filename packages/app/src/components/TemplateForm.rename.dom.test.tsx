import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  saveTemplate: vi.fn(async (_input: { name: string }) => ({ ok: true as const, warnings: [] })),
  moveTemplate: vi.fn(async (_input: { toName: string }) => ({ ok: true as const })),
}));

vi.mock('@/lib/folder-config-api', () => api);

const { useTemplateForm } = await import('./TemplateForm');

function renderEditForm(name: string) {
  return renderHook(() =>
    useTemplateForm({
      mode: 'edit',
      folderPath: 'notes',
      scope: 'local',
      initial: { name, title: 'Menu', description: '', body: '# Menu\n' },
      onCommitted: () => {},
    }),
  );
}

describe('useTemplateForm edit save', () => {
  beforeEach(() => {
    api.saveTemplate.mockClear();
    api.moveTemplate.mockClear();
  });

  test('a title-only save of a decomposed template saves under the stored name', async () => {
    const { result } = renderEditForm('cafe\u{0301}');
    act(() => result.current.setTitle('Specials'));
    await act(() => result.current.submit());
    expect(api.moveTemplate).not.toHaveBeenCalled();
    expect(api.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cafe\u{0301}' }),
    );
  });

  test('re-entering a composed name in decomposed form saves instead of moving', async () => {
    const { result } = renderEditForm('caf\u{00E9}');
    act(() => result.current.setSlug('cafe\u{0301}'));
    await act(() => result.current.submit());
    expect(api.moveTemplate).not.toHaveBeenCalled();
    expect(api.saveTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: 'caf\u{00E9}' }));
  });

  test('a new name moves the template to its composed spelling', async () => {
    const { result } = renderEditForm('meeting');
    act(() => result.current.setSlug('cafe\u{0301}'));
    await act(() => result.current.submit());
    expect(api.moveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ fromName: 'meeting', toName: 'caf\u{00E9}' }),
    );
  });
});
