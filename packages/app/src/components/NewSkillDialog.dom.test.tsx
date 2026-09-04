import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_NEW_SKILL_DESCRIPTION } from '@/hooks/use-create-blank-skill';
import { NewSkillDialog } from './NewSkillDialog';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

function renderDialog(existingNames: Set<string> = new Set()) {
  const onCreate = vi.fn();
  render(
    <NewSkillDialog
      open
      scope="project"
      existingNames={existingNames}
      busy={false}
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  return { onCreate };
}

describe('NewSkillDialog (PRD-7602)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test('pre-fills first-free name + default description; one click creates a valid skill', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog(new Set(['new-skill']));

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('new-skill-2');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
      DEFAULT_NEW_SKILL_DESCRIPTION,
    );

    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({
      name: 'new-skill-2',
      description: DEFAULT_NEW_SKILL_DESCRIPTION,
    });
  });

  test('a typed name and description flow through', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'my-skill');
    const desc = screen.getByLabelText('Description');
    await user.clear(desc);
    await user.type(desc, 'Does a thing.');

    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({ name: 'my-skill', description: 'Does a thing.' });
  });

  test('rejects an invalid name and a duplicate, without calling onCreate', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog(new Set(['taken']));

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Bad Name');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/lowercase/i);

    await user.clear(name);
    await user.type(name, 'taken');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/already exists/i);
  });
});
