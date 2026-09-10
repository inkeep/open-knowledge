import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const deleteSkill = vi.fn();
const closeTabs = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
const noop = vi.fn();

vi.doMock('@/lib/skills-api', () => ({ deleteSkill }));
vi.doMock('sonner', () => ({
  toast: { error: vi.fn(), success: toastSuccess, warning: toastWarning },
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ closeTabs, openTabs: [] }),
}));

function skill(name: string) {
  return {
    scope: 'project' as const,
    name,
    path: `.agents/skills/${name}/SKILL.md`,
    installed: true,
    hosts: [],
  };
}

const ALPHA_WARNING =
  'Also removed a copy at .ok/skills/alpha that an earlier failed move had kept.';
const GAMMA_WARNING =
  'Also removed a copy at .ok/skills/gamma that an earlier failed move had kept.';

async function confirmDelete() {
  await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
}

describe('SkillDeleteDialog surfaces a successful-deletion warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderDialog() {
    const { SkillDeleteDialog } = await import('./SkillDeleteDialog');
    render(<SkillDeleteDialog skill={skill('alpha')} onOpenChange={noop} onDeleted={noop} />);
  }

  test('the server sentence is shown verbatim instead of a plain success', async () => {
    deleteSkill.mockResolvedValue({ ok: true, existed: true, warnings: [ALPHA_WARNING] });
    await renderDialog();

    await confirmDelete();

    await waitFor(() => expect(toastWarning).toHaveBeenCalled());
    const [, options] = toastWarning.mock.calls[0] as [
      string,
      { description: string; duration: number },
    ];
    expect(options.description).toBe(ALPHA_WARNING);
    expect(options.duration).toBeGreaterThan(4000);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(closeTabs).toHaveBeenCalled();
  });

  test('a delete the server had nothing to say about keeps the plain success', async () => {
    deleteSkill.mockResolvedValue({ ok: true, existed: true, warnings: [] });
    await renderDialog();

    await confirmDelete();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe('SkillBulkDeleteDialog keeps each warning attributed to its skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('two warned skills stay distinguishable and the quiet one is not named', async () => {
    deleteSkill
      .mockResolvedValueOnce({ ok: true, existed: true, warnings: [ALPHA_WARNING] })
      .mockResolvedValueOnce({ ok: true, existed: true, warnings: [] })
      .mockResolvedValueOnce({ ok: true, existed: true, warnings: [GAMMA_WARNING] });
    const { SkillBulkDeleteDialog } = await import('./SkillBulkDeleteDialog');
    render(
      <SkillBulkDeleteDialog
        skills={[skill('alpha'), skill('beta'), skill('gamma')]}
        onOpenChange={noop}
        onDeleted={noop}
      />,
    );

    await confirmDelete();

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    const [, options] = toastWarning.mock.calls[0] as [
      string,
      { description: ReactElement; duration: number },
    ];
    const { container } = render(options.description);

    expect(container.textContent).toContain(`alpha: ${ALPHA_WARNING}`);
    expect(container.textContent).toContain(`gamma: ${GAMMA_WARNING}`);
    expect(container.textContent).not.toContain('beta');
    expect(options.duration).toBeGreaterThan(4000);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test('a bulk delete the server had nothing to say about keeps the plain success', async () => {
    deleteSkill.mockResolvedValue({ ok: true, existed: true, warnings: [] });
    const { SkillBulkDeleteDialog } = await import('./SkillBulkDeleteDialog');
    render(
      <SkillBulkDeleteDialog
        skills={[skill('alpha'), skill('beta')]}
        onOpenChange={noop}
        onDeleted={noop}
      />,
    );

    await confirmDelete();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastWarning).not.toHaveBeenCalled();
  });
});
