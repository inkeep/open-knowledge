import type { LintDiagnostic } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('./EditorBreadcrumb', () => ({
  EditorBreadcrumb: ({ docName }: { docName: string | null }) => (
    <span data-testid="editor-breadcrumb-probe">{docName}</span>
  ),
}));

// The breadcrumb cell's NotInSidebarIndicator reads merged config through the
// context hook, which throws without a provider — stub the app-default view
// (no toggles set, binding absent) so the toolbar mounts standalone.
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: {},
    projectLocalSynced: true,
    projectLocalBinding: null,
  }),
}));

// The skill cluster's real children fetch the skills list and the install
// state, none of which this toolbar's contract depends on. The stub keeps the
// REAL Add-properties button so the badge it renders is the one under test.
vi.doMock('./SkillToolbarControls', async () => {
  const { AddPropertiesButton } = await import('./AddPropertiesButton');
  return {
    SkillToolbarControls: ({
      showAddPropertyButton,
      onAddProperty,
      problemCount,
      problemMessages,
    }: {
      showAddPropertyButton: boolean;
      onAddProperty: () => void;
      problemCount?: number;
      problemMessages?: readonly string[];
    }) =>
      showAddPropertyButton ? (
        <AddPropertiesButton
          onAddProperty={onAddProperty}
          problemCount={problemCount}
          problemMessages={problemMessages}
        />
      ) : null,
  };
});

vi.doMock('./SkillOriginInline', () => ({
  SkillOriginInline: () => null,
}));

/** A schema-required property the document does not have. */
function missing(property: string): LintDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: 'warning',
    source: 'frontmatter',
    code: 'required',
    message: `Frontmatter property "${property}" is required`,
    frontmatterScope: 'missing',
    frontmatterProperty: property,
  };
}

describe('EditorToolbar runtime layout', () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'okDesktop');
  });

  async function renderToolbar(
    activeDocName = 'docs/Page.md',
    frontmatterProblems?: readonly LintDiagnostic[],
  ) {
    const { EditorToolbar } = await import('./EditorToolbar');

    render(
      <TooltipProvider>
        <EditorToolbar
          activeDocName={activeDocName}
          isSourceMode={false}
          sourceDisabled={false}
          onModeChange={() => {}}
          showAddPropertyButton={true}
          onAddProperty={() => {}}
          frontmatterProblems={frontmatterProblems}
          isPanelCollapsed={false}
          onTogglePanel={() => {}}
        />
      </TooltipProvider>,
    );
  }

  test('toolbar overlay lets editor clicks pass through except explicit cells', async () => {
    await renderToolbar();

    const toolbar = screen.getByTestId('editor-toolbar');
    expectVisualClassTokens(toolbar.className, ['pointer-events-none']);

    const breadcrumbCell = screen.getByTestId('editor-breadcrumb-probe').parentElement;
    expectVisualClassTokens(breadcrumbCell?.className, ['pointer-events-auto']);
  });

  test('content-column wrapper encloses the three-column toolbar grid', async () => {
    await renderToolbar();

    const toolbar = screen.getByTestId('editor-toolbar');
    const alignedWrapper = toolbar.querySelector('.editor-content-aligned');
    expect(alignedWrapper).toBeTruthy();

    const grid = alignedWrapper?.querySelector('.grid.grid-cols-3');
    expect(grid).toBeTruthy();
  });

  test('mode toggle stays centered in the middle toolbar cell', async () => {
    await renderToolbar();

    const sourceButton = screen.getByRole('radio', { name: 'Markdown source' });
    const middleCell = sourceButton.closest('.pointer-events-auto.flex.justify-center');
    expect(middleCell).toBeTruthy();
  });

  test('mode toggle is hidden for editable text docs, kept for markdown and Mermaid', async () => {
    await renderToolbar('src/util.ts');
    expect(screen.queryByRole('radio', { name: 'Markdown source' })).toBeNull();
    cleanup();

    await renderToolbar('docs/Page.md');
    expect(screen.getByRole('radio', { name: 'Markdown source' })).toBeTruthy();
    cleanup();

    // Mermaid docs keep the toggle — diagram (wysiwyg) vs source are two
    // real surfaces, unlike a text doc's single CodeMirror.
    await renderToolbar('assets/flow.mmd');
    expect(screen.getByRole('radio', { name: 'Markdown source' })).toBeTruthy();
  });

  test('renders the document-panel shortcut as a Kbd keycap', async () => {
    const user = userEvent.setup();
    await renderToolbar();

    await user.hover(
      screen.getByRole('button', {
        name: `Hide panel (${formatShortcutLabel('toggle-document-panel')})`,
      }),
    );
    const tooltip = await screen.findByRole('tooltip', {
      name: `Hide panel ${formatShortcutLabel('toggle-document-panel')}`,
    });
    expect(tooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('toggle-document-panel'),
    );
  });

  test('hides the document-panel toggle in a note window', async () => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: { config: { mode: 'note' } },
    });

    await renderToolbar();

    expect(document.querySelector('[data-doc-panel-toggle]')).toBeNull();
  });

  test('a tree-hidden doc gets the not-in-sidebar indicator beside the breadcrumb', async () => {
    await renderToolbar('.scratch/hidden-note');

    const indicator = screen.getByTestId('not-in-sidebar-indicator');
    // Same interactive cell as the breadcrumb — the toolbar grid is
    // pointer-events-none, so anything outside an auto cell is unclickable.
    const breadcrumbCell = screen.getByTestId('editor-breadcrumb-probe').parentElement;
    expect(breadcrumbCell?.contains(indicator)).toBe(true);
    expectVisualClassTokens(breadcrumbCell?.className, ['pointer-events-auto']);
  });

  test('a doc with a visible tree row renders no indicator', async () => {
    await renderToolbar();

    expect(screen.queryByTestId('not-in-sidebar-indicator')).toBeNull();
  });

  // The button's tooltip promises "click to add and fill them in", and clicking
  // stages a row per missing property EXCEPT the ones reserved for the doc — a
  // skill's `name` is its folder identity, renamed by moving the folder. Badging
  // one would advertise an action the click will not take. The schema violation
  // is not hidden: the Problems panel still reports it.
  test('a skill badges only the missing properties clicking will stage', async () => {
    const user = userEvent.setup();
    await renderToolbar('__skill__/global/foo', [missing('name'), missing('description')]);

    const badge = await screen.findByTestId('add-properties-problem-badge');
    expect(badge.textContent).toBe('1');

    await user.hover(screen.getByTestId('add-properties-button'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Frontmatter property "description" is required');
    expect(tooltip.textContent).not.toContain('Frontmatter property "name" is required');
  });

  test('an ordinary document reserves nothing, so `name` still badges', async () => {
    await renderToolbar('docs/Page.md', [missing('name'), missing('description')]);

    expect((await screen.findByTestId('add-properties-problem-badge')).textContent).toBe('2');
  });

  test('two schemas requiring one property badge once and list it once', async () => {
    // Composed the way EditorArea feeds this prop, because that is where the
    // per-property collapse happens — two producers each requiring `type` (an
    // OKF profile beside a project's own schema) is one row to add, and the
    // tooltip promises exactly what the click will stage.
    const { partitionFrontmatterProblems } = await import('@/editor/useFrontmatterDiagnostics');
    const user = userEvent.setup();
    const bothRequireType = [
      { ...missing('type'), source: 'okf' as const, code: 'frontmatter-required' },
      missing('type'),
    ];
    await renderToolbar('docs/Page.md', partitionFrontmatterProblems(bothRequireType).missing);

    expect((await screen.findByTestId('add-properties-problem-badge')).textContent).toBe('1');

    await user.hover(screen.getByTestId('add-properties-button'));
    const tooltip = await screen.findByRole('tooltip');
    const rows = tooltip.textContent?.split('Frontmatter property "type" is required').length;
    expect(rows).toBe(2);
  });
});
