import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ComposerMentionInputHandle } from '@/editor/ComposerMentionInput';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ComposerAddMenu', () => {
  test('composes the shared prompt additions without forcing every surface to expose commands', async () => {
    const user = userEvent.setup();
    const onComments = vi.fn(() => {});
    const onMention = vi.fn(() => {});
    const {
      ComposerAddMenu,
      ComposerCommentsMenuItem,
      ComposerFilesMenuItem,
      ComposerMentionMenuItem,
    } = await import('./ComposerAddMenu');

    render(
      <TooltipProvider>
        <ComposerAddMenu testId="composer-add">
          <ComposerFilesMenuItem onFiles={() => {}} />
          <ComposerCommentsMenuItem count={3} onSelect={onComments} />
          <ComposerMentionMenuItem onSelect={onMention} />
        </ComposerAddMenu>
      </TooltipProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));

    expect(screen.getByRole('menuitem', { name: 'Attach files' })).toBeDefined();
    const commentsItem = screen.getByRole('menuitem', { name: 'Attach comments: 3' });
    expect(commentsItem).toBeDefined();
    expect(within(commentsItem).getByText('3')).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Mention a page' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Commands' })).toBeNull();

    await user.click(screen.getByRole('menuitem', { name: 'Mention a page' }));
    expect(onMention).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));
    await user.click(screen.getByRole('menuitem', { name: 'Attach comments: 3' }));
    expect(onComments).toHaveBeenCalledTimes(1);
  });

  test('the ACP variant can add a commands entry without changing the shared trigger', async () => {
    const user = userEvent.setup();
    const composerRef = createRef<ComposerMentionInputHandle>();
    const { ComposerAddMenu, ComposerCommandsMenuItem, ComposerFilesMenuItem } = await import(
      './ComposerAddMenu'
    );
    const { ComposerMentionInput } = await import('@/editor/ComposerMentionInput');

    render(
      <TooltipProvider>
        <ComposerMentionInput
          ref={composerRef}
          ariaLabel="Prompt"
          attachmentDrop={{ kind: 'host' }}
          onEmptyChange={() => {}}
          onSubmit={() => {}}
          slashCommands={[{ name: 'review', description: 'Review the current diff' }]}
        />
        <ComposerAddMenu testId="composer-add">
          <ComposerFilesMenuItem onFiles={() => {}} attachmentMode="reference" />
          <ComposerCommandsMenuItem
            onSelect={() => composerRef.current?.openSlashCommandPicker()}
          />
        </ComposerAddMenu>
      </TooltipProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));
    expect(
      screen.getByRole('menuitem', {
        name: 'Attach files · references only (no embedded contents)',
      }).textContent,
    ).toBe('Attach files · references only (no embedded contents)');
    await user.click(screen.getByRole('menuitem', { name: 'Commands' }));

    await waitFor(() => {
      expect(document.querySelector('[data-composer-portal]')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Prompt' }));
    });
  });

  test('choosing Attach files preserves the existing multi-file picker behavior', async () => {
    const user = userEvent.setup();
    const notesFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const imageFile = new File(['image'], 'diagram.png', { type: 'image/png' });
    const onFiles = vi.fn((_files: readonly File[]) => {});
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      expect(this.multiple).toBe(true);
      Object.defineProperty(this, 'files', {
        configurable: true,
        value: [notesFile, imageFile],
      });
      this.dispatchEvent(new Event('change'));
    });
    const { ComposerAddMenu, ComposerFilesMenuItem } = await import('./ComposerAddMenu');

    render(
      <TooltipProvider>
        <ComposerAddMenu testId="composer-add">
          <ComposerFilesMenuItem onFiles={onFiles} />
        </ComposerAddMenu>
      </TooltipProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));
    await user.click(screen.getByRole('menuitem', { name: 'Attach files' }));

    expect(onFiles).toHaveBeenCalledWith([notesFile, imageFile]);
    clickSpy.mockRestore();
  });

  test('choosing Mention a page leaves keyboard focus in the composer', async () => {
    const user = userEvent.setup();
    const composerRef = createRef<ComposerMentionInputHandle>();
    const { ComposerAddMenu, ComposerMentionMenuItem } = await import('./ComposerAddMenu');
    const { ComposerMentionInput } = await import('@/editor/ComposerMentionInput');

    render(
      <TooltipProvider>
        <ComposerMentionInput
          ref={composerRef}
          ariaLabel="Prompt"
          attachmentDrop={{ kind: 'host' }}
          onEmptyChange={() => {}}
          onSubmit={() => {}}
        />
        <ComposerAddMenu testId="composer-add">
          <ComposerMentionMenuItem onSelect={() => composerRef.current?.openMentionPicker()} />
        </ComposerAddMenu>
      </TooltipProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mention a page' }));

    await waitFor(() => {
      expect(document.querySelector('[data-composer-portal]')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Prompt' }));
    });
  });

  test('pressing Escape returns keyboard focus to the add menu trigger', async () => {
    const user = userEvent.setup();
    const { ComposerAddMenu, ComposerMentionMenuItem } = await import('./ComposerAddMenu');

    render(
      <TooltipProvider>
        <ComposerAddMenu testId="composer-add">
          <ComposerMentionMenuItem onSelect={() => {}} />
        </ComposerAddMenu>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Add to prompt' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(document.querySelector('[data-composer-portal]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  test('picker-opening items require the shared menu scheduler', async () => {
    const { ComposerCommandsMenuItem, ComposerMentionMenuItem } = await import('./ComposerAddMenu');

    for (const MenuItem of [ComposerMentionMenuItem, ComposerCommandsMenuItem]) {
      expect(() => render(<MenuItem onSelect={() => {}} />)).toThrow(
        'Composer picker menu items must be rendered inside ComposerAddMenu',
      );
    }
  });
});
