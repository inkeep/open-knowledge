import type { UninstallProjectRow } from '@inkeep/open-knowledge-core';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { UninstallPickerScreen } from './UninstallPickerScreen';
import { UninstallProgressScreen } from './UninstallProgressScreen';
import { UninstallSurveyScreen } from './UninstallSurveyScreen';

/**
 * Copy lock for the render-swap: the picker, survey, and progress screens moved
 * their user-facing copy out of hand-written inline HTML and into Lingui
 * `<Trans>` / t`…`. This freezes the strings each screen renders today and
 * asserts the migrated React screens still render them verbatim, so an
 * accidental reword fails a test rather than passing an eyeball.
 *
 * Provenance differs by screen, so read this as a current-copy lock, not a
 * verbatim-parity-with-the-old-windows gate. The survey and progress strings
 * are the pre-migration originals, captured from the inline-HTML builders
 * (`buildDesktopUninstall{Feedback,Progress}Html`) and checked
 * substring-for-substring against their rendered output before those builders
 * were deleted. The picker's copy was deliberately reworked during the
 * migration — the description merged into one line and reworded to name the
 * project selection, the muted hint and scroll line dropped, the open/running
 * tags collapsed to `active`, and the footer count restyled into a header
 * selected-of-total fraction — so the picker strings below are the current
 * intended copy, not the pre-migration originals.
 *
 * The notice screens are out of scope here: their copy is main-process data
 * (`desktopUninstall{Confirm,Completion,Failure,FinalStep}Notice`) rendered
 * through, not migrated to, Lingui, and stays pinned by the desktop notice
 * builder tests.
 */

/** Text, accessible names, and placeholders — everything the user can read. */
function readableCopy(container: HTMLElement): string {
  const attrs: string[] = [];
  for (const el of container.querySelectorAll('[aria-label], [placeholder]')) {
    const label = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    if (label !== null) attrs.push(label);
    if (placeholder !== null) attrs.push(placeholder);
  }
  return [container.textContent ?? '', ...attrs].join('\n');
}

const PICKER_COPY = [
  'Uninstall OpenKnowledge?',
  'This removes OpenKnowledge’s settings and integrations from your Mac and any projects you select below, but keeps your markdown content and authored skills.',
  'Select all',
  'Cancel',
  'Uninstall OpenKnowledge',
  'Detected OpenKnowledge projects',
  'Remove OpenKnowledge from ',
];

const SURVEY_COPY = [
  'Thanks for giving OpenKnowledge a try.',
  'What you share is sent to the OpenKnowledge team.',
  'Before you go, mind sharing why?',
  "It didn't fit into my workflow",
  'It was missing a feature I needed',
  'It was too hard to set up or get started',
  'Bugs, crashes, or it felt unreliable',
  "I'm switching to another tool",
  'It was a trial or one-off project',
  'Something else',
  "Anything you'd like to add? (optional)",
  'Let us follow up by email',
  'Email address',
  'you@company.com',
  'Skip',
  'Send & continue',
];

const PROGRESS_COPY = [
  'Removing OpenKnowledge files…',
  'This may take a moment. Your markdown content is kept.',
];

const twoProjects: readonly UninstallProjectRow[] = [
  { path: '/work/a', open: true, recent: false, running: true },
  { path: '/work/b', open: false, recent: true, running: false },
];
const oneProject: readonly UninstallProjectRow[] = [
  { path: '/work/a', open: false, recent: true, running: false },
];

describe('uninstall copy parity', () => {
  afterEach(cleanup);

  test('picker renders the original copy, tags, and plural forms', () => {
    const { container } = render(
      <UninstallPickerScreen projects={twoProjects} onConfirm={() => {}} onCancel={() => {}} />,
    );
    const copy = readableCopy(container);

    for (const line of PICKER_COPY) expect(copy, line).toContain(line);
    // Status badges intentionally diverge from the inline-HTML open/running/recent
    // tags: open + running collapse to `active` (the open/server split is not a
    // user decision), leaving `active` / `recent`. twoProjects has one of each.
    for (const status of ['active', 'recent']) expect(copy).toContain(status);
    // Header selected-of-total counter (none selected yet, two projects).
    expect(copy).toContain('0 / 2');
  });

  test('picker renders the singular plural forms', async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <UninstallPickerScreen projects={oneProject} onConfirm={() => {}} onCancel={() => {}} />,
    );

    let copy = readableCopy(container);
    expect(copy).toContain('0 / 1');

    await user.click(getByRole('checkbox', { name: 'Select all' }));
    copy = readableCopy(container);
    expect(copy).toContain('1 / 1');
  });

  test('picker renders the empty-state copy', () => {
    const { container } = render(
      <UninstallPickerScreen projects={[]} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(readableCopy(container)).toContain(
      'No active or recent OpenKnowledge projects were found.',
    );
  });

  test('survey renders the original copy', () => {
    const { container } = render(<UninstallSurveyScreen onSend={() => {}} onSkip={() => {}} />);
    const copy = readableCopy(container);
    for (const line of SURVEY_COPY) expect(copy, line).toContain(line);
  });

  test('progress renders the original copy', () => {
    const { container } = render(<UninstallProgressScreen />);
    const copy = readableCopy(container);
    for (const line of PROGRESS_COPY) expect(copy, line).toContain(line);
  });
});
