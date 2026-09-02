import type { SkillSearchResult } from '@inkeep/open-knowledge-core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const fetchSkillPreview = vi.fn();
vi.doMock('@/lib/skills-api', () => ({ fetchSkillPreview }));

const { SkillDirectoryResult } = await import('@/components/SkillDirectoryResult');
const { clearSkillCardCostCache } = await import('@/lib/skill-card-cost');

const RESULT: SkillSearchResult = {
  id: 'acme/skills/writer',
  name: 'writer',
  source: 'acme/skills',
  description: 'Writes things.',
  installs: 1200,
  publisher: 'acme',
};

function previewOk(description: string) {
  return {
    ok: true as const,
    name: 'writer',
    description,
    skillMd: `---\nname: writer\ndescription: ${description}\n---\n\n${'b'.repeat(400)}`,
    files: [],
  };
}

function renderCard() {
  return render(<SkillDirectoryResult result={RESULT} imported={null} onOpen={() => {}} />);
}

beforeEach(() => {
  clearSkillCardCostCache();
  fetchSkillPreview.mockReset();
});
afterEach(() => {
  clearSkillCardCostCache();
});

describe('SkillDirectoryResult context cost', () => {
  test('a card that is never hovered performs no work', () => {
    renderCard();
    expect(fetchSkillPreview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('skill-card-always-on')).toBeNull();
  });

  test('hovering resolves the always-on figure onto the meta line', async () => {
    fetchSkillPreview.mockResolvedValue(previewOk('d'.repeat(200)));
    renderCard();
    fireEvent.mouseEnter(screen.getByRole('listitem'));
    const figure = await screen.findByTestId('skill-card-always-on');
    expect(figure.textContent).toContain('52');
    expect(fetchSkillPreview).toHaveBeenCalledTimes(1);
  });

  test('keyboard focus resolves it too — mouseEnter never fires for keyboard users', async () => {
    fetchSkillPreview.mockResolvedValue(previewOk('d'.repeat(200)));
    renderCard();
    fireEvent.focus(screen.getByRole('listitem'));
    await screen.findByTestId('skill-card-always-on');
    expect(fetchSkillPreview).toHaveBeenCalledTimes(1);
  });

  test('a failed fetch leaves the card exactly as it renders today', async () => {
    fetchSkillPreview.mockResolvedValue({ ok: false, error: 'clone failed' });
    renderCard();
    fireEvent.mouseEnter(screen.getByRole('listitem'));
    await waitFor(() => expect(fetchSkillPreview).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('skill-card-always-on')).toBeNull();
    expect(screen.getByText('acme')).toBeTruthy();
  });

  test('a thrown fetch is swallowed rather than surfaced on a decorative figure', async () => {
    fetchSkillPreview.mockRejectedValue(new Error('network'));
    renderCard();
    fireEvent.mouseEnter(screen.getByRole('listitem'));
    await waitFor(() => expect(fetchSkillPreview).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('skill-card-always-on')).toBeNull();
  });

  test('re-hovering a resolved card does not re-fetch', async () => {
    fetchSkillPreview.mockResolvedValue(previewOk('d'.repeat(200)));
    const { unmount } = renderCard();
    fireEvent.mouseEnter(screen.getByRole('listitem'));
    await screen.findByTestId('skill-card-always-on');
    unmount();

    renderCard();
    expect(screen.getByTestId('skill-card-always-on')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole('listitem'));
    expect(fetchSkillPreview).toHaveBeenCalledTimes(1);
  });

  test('a failed source is not retried on every re-hover', async () => {
    fetchSkillPreview.mockResolvedValue({ ok: false, error: 'clone failed' });
    renderCard();
    const card = screen.getByRole('listitem');
    fireEvent.mouseEnter(card);
    await waitFor(() => expect(fetchSkillPreview).toHaveBeenCalledTimes(1));
    fireEvent.mouseEnter(card);
    fireEvent.focus(card);
    expect(fetchSkillPreview).toHaveBeenCalledTimes(1);
  });
});
