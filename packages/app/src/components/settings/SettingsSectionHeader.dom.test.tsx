import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsSectionHeader } from './SettingsSectionHeader';

type GlobalWithShims = typeof globalThis & { ResizeObserver?: unknown };
const g = globalThis as GlobalWithShims;
if (g.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
}

function renderHeader(props: Parameters<typeof SettingsSectionHeader>[0]) {
  return render(
    <TooltipProvider>
      <SettingsSectionHeader {...props} />
    </TooltipProvider>,
  );
}

describe('SettingsSectionHeader', () => {
  afterEach(() => cleanup());

  test('a page header is an h3 at the page size', () => {
    renderHeader({ titleId: 'settings-x-title', title: 'Search', scope: 'project-local' });
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.textContent).toBe('Search');
    expect(heading.className).toContain('text-lg');
    expect(screen.getByTestId('settings-scope-badge-project-local')).not.toBeNull();
  });

  test('a block header drops a rank and a size below its page', () => {
    renderHeader({
      titleId: 'settings-y-title',
      title: 'Attachments',
      scope: 'project',
      level: 'block',
    });
    const heading = screen.getByRole('heading', { level: 4 });
    expect(heading.textContent).toBe('Attachments');
    expect(heading.className).toContain('text-base');
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });

  test('the title wires up aria-labelledby and the description renders under it', () => {
    renderHeader({
      titleId: 'settings-z-title',
      title: 'Sync',
      scope: 'project-local',
      children: 'Keep this project in sync.',
    });
    expect(screen.getByRole('heading', { level: 3 }).id).toBe('settings-z-title');
    expect(screen.getByText('Keep this project in sync.')).not.toBeNull();
  });

  test('a section with no scope renders no badge', () => {
    renderHeader({ title: 'Plain' });
    expect(screen.queryByTestId('settings-scope-badge-user')).toBeNull();
    expect(screen.queryByTestId('settings-scope-badge-project')).toBeNull();
    expect(screen.queryByTestId('settings-scope-badge-project-local')).toBeNull();
  });

  test('an adornment renders in the title row before the scope badge', () => {
    renderHeader({
      titleId: 'settings-adorn-title',
      title: 'Config sharing',
      scope: 'project',
      level: 'block',
      adornment: <span data-testid="header-adornment">info</span>,
    });
    const adornment = screen.getByTestId('header-adornment');
    const badge = screen.getByTestId('settings-scope-badge-project');
    expect(
      adornment.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('a beta header renders the maturity tag before the scope badge', () => {
    renderHeader({ titleId: 'settings-beta-title', title: 'Slidev', scope: 'user', beta: true });

    const beta = screen.getByText('Beta');
    const badge = screen.getByTestId('settings-scope-badge-user');
    expect(beta).not.toBeNull();
    expect(beta.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('a header without beta renders no maturity tag', () => {
    renderHeader({ titleId: 'settings-nobeta-title', title: 'Slidev', scope: 'user' });
    expect(screen.queryByText('Beta')).toBeNull();
  });

  test('a ReactNode title falls back to a generic docs-link label', () => {
    renderHeader({
      titleId: 'settings-node-title',
      title: <span>Slidev</span>,
      scope: 'user',
      docUrl: 'https://example.test/slidev',
    });
    expect(screen.getByTestId('settings-node-title-docs-link').getAttribute('aria-label')).toBe(
      'Learn more',
    );
  });

  test('a docs link names its destination for out-of-context listings', () => {
    renderHeader({
      titleId: 'settings-doc-title',
      title: 'Slidev',
      scope: 'user',
      docUrl: 'https://example.test/slidev',
    });
    const link = screen.getByTestId('settings-doc-title-docs-link');
    expect(link.getAttribute('href')).toBe('https://example.test/slidev');
    expect(link.getAttribute('aria-label')).toContain('Slidev');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
