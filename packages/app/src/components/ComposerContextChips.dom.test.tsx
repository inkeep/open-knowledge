import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

afterEach(() => cleanup());

async function renderChips(files: string[], onRemoveFile = () => {}) {
  const { ComposerContextChips } = await import('./ComposerContextChips');
  return render(<ComposerContextChips files={files} onRemoveFile={onRemoveFile} />);
}

describe('ComposerContextChips', () => {
  test('renders one chip per file with a compact basename label + full-path title', async () => {
    await renderChips(['specs/foo/SPEC.md', 'notes.md']);
    const chip = screen.getByTestId('composer-context-chip-file-specs/foo/SPEC.md');
    expect(chip.textContent).toContain('SPEC.md');
    expect(chip.getAttribute('title')).toBe('specs/foo/SPEC.md');
    expect(screen.getByTestId('composer-context-chip-file-notes.md').textContent).toContain(
      'notes.md',
    );
  });

  test('the remove control is the LEADING icon-button, with no trailing × slot', async () => {
    await renderChips(['notes.md']);
    const chip = screen.getByTestId('composer-context-chip-file-notes.md');
    const removeBtn = screen.getByRole('button', { name: /Remove notes\.md from context/i });
    expect(chip.firstElementChild).toBe(removeBtn);
    expect(removeBtn.querySelectorAll('svg').length).toBe(2);
    expect(chip.querySelectorAll('button').length).toBe(1);
  });

  test('the leading icon is type-aware across folders, pages, video, and audio', async () => {
    await renderChips(['specs/foo', 'notes.md', 'clips/demo.mp4', 'audio/theme.mp3']);
    const folderChip = screen.getByTestId('composer-context-chip-file-specs/foo');
    const pageChip = screen.getByTestId('composer-context-chip-file-notes.md');
    const videoChip = screen.getByTestId('composer-context-chip-file-clips/demo.mp4');
    const audioChip = screen.getByTestId('composer-context-chip-file-audio/theme.mp3');
    expect(
      folderChip.querySelector('button > span:first-child [data-file-entry-icon="folder"]'),
    ).not.toBeNull();
    expect(
      pageChip.querySelector('button > span:first-child [data-testid="file-entry-icon-markdown"]'),
    ).not.toBeNull();
    expect(
      videoChip.querySelector('button > span:first-child [data-testid="file-entry-icon-video"]'),
    ).not.toBeNull();
    expect(
      audioChip.querySelector('button > span:first-child [data-testid="file-entry-icon-audio"]'),
    ).not.toBeNull();
    const folderIcon = folderChip.querySelector('button svg')?.outerHTML;
    const pageIcon = pageChip.querySelector('button svg')?.outerHTML;
    const videoIcon = videoChip.querySelector('button svg')?.outerHTML;
    const audioIcon = audioChip.querySelector('button svg')?.outerHTML;
    expect(folderIcon).toBeDefined();
    expect(pageIcon).toBeDefined();
    expect(videoIcon).toBeDefined();
    expect(audioIcon).toBeDefined();
    expect(new Set([folderIcon, pageIcon, videoIcon, audioIcon]).size).toBe(4);
  });

  test('renders nothing when the file set is empty', async () => {
    const { container } = await renderChips([]);
    expect(container.querySelector('[data-testid="composer-context-chips"]')).toBeNull();
  });

  test('clicking the × calls onRemoveFile with the path', async () => {
    const calls: string[] = [];
    await renderChips(['notes.md'], (p) => calls.push(p));
    fireEvent.click(screen.getByRole('button', { name: /Remove notes\.md from context/i }));
    expect(calls).toEqual(['notes.md']);
  });

  test('Backspace / Delete on the focusable × calls onRemoveFile', async () => {
    const calls: string[] = [];
    await renderChips(['notes.md'], (p) => calls.push(p));
    const removeBtn = screen.getByRole('button', { name: /Remove notes\.md from context/i });
    fireEvent.keyDown(removeBtn, { key: 'Backspace' });
    fireEvent.keyDown(removeBtn, { key: 'Delete' });
    expect(calls).toEqual(['notes.md', 'notes.md']);
  });
});
