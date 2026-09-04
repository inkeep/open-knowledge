import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { skillFileTabId } from '@/editor/editor-tabs';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const deleteSkillFile = vi.fn();
const closeTabs = vi.fn();
const onOpenChange = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.doMock('@/lib/skills-api', () => ({ deleteSkillFile }));
vi.doMock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    closeTabs,
    openTabs: [scriptTabId, 'notes/standup'],
  }),
}));

const scriptTabId = skillFileTabId({
  scope: 'project',
  name: 'demo',
  path: 'scripts/run.sh',
});

const skill = {
  scope: 'project' as const,
  name: 'demo',
  path: '.agents/skills/demo/SKILL.md',
  installed: true,
  hosts: [],
};

async function renderDialog() {
  const { SkillFileDeleteDialog } = await import('./SkillFileDeleteDialog');
  render(
    <SkillFileDeleteDialog
      target={{ skill, filePath: 'scripts/run.sh' }}
      onOpenChange={onOpenChange}
    />,
  );
  return screen.getByRole('button', { name: /^Delete$/ });
}

describe('SkillFileDeleteDialog outcome branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('a real delete evicts the file tab and closes the dialog', async () => {
    deleteSkillFile.mockResolvedValue({ ok: true, existed: true });
    const confirm = await renderDialog();

    await userEvent.click(confirm);

    expect(deleteSkillFile).toHaveBeenCalledWith({
      scope: 'project',
      name: 'demo',
      path: 'scripts/run.sh',
    });
    expect(closeTabs).toHaveBeenCalledWith([scriptTabId], { force: true });
    expect(toastSuccess).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('a miss reports failure, closes the dialog, and evicts NOTHING', async () => {
    deleteSkillFile.mockResolvedValue({ ok: true, existed: false });
    const confirm = await renderDialog();

    await userEvent.click(confirm);

    expect(closeTabs).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('a failed request keeps the dialog open and evicts NOTHING', async () => {
    deleteSkillFile.mockResolvedValue({ ok: false, error: 'boom' });
    const confirm = await renderDialog();

    await userEvent.click(confirm);

    expect(closeTabs).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
