/**
 * RTL tests for the skills.sh directory card's hover-resolved context cost.
 *
 * The figure costs a server-side clone to produce, so the load-bearing property
 * is not "it renders" but "it is never fetched for a card nobody pointed at".
 * These assert both halves, plus the failure path (a card whose source cannot be
 * fetched must render exactly as it does today) and the session memo that keeps
 * a re-hover from re-fetching.
 */

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

/** A preview payload whose name + description price out to a known always-on. */
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
    // name (6) + description (200) = 206 chars -> ~52 tokens at chars/4.
    expect(figure.textContent).toContain('~52');
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
    // The rest of the meta line is untouched.
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
    // Seeded from the session memo — present without any further fetch.
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
