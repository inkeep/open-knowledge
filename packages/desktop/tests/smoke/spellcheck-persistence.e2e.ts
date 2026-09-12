import { join } from 'node:path';
import { resolveDesktopTarget } from './_helpers/launch-desktop';
import { PLATFORM_SKIP_REASON, PLATFORM_SUPPORTED, SMOKE_ENABLED } from './_helpers/platform-gate';
import {
  applicationMenuSpellcheck,
  awaitEngineSpellcheckEnabled,
  closeAppForRelaunch,
  closeSettingsDialog,
  findAppStateFiles,
  findEditorWindowForProject,
  openProjectFromRecents,
  openSettingsDialog,
  openSpellingSettings,
  pickNonDefaultSelection,
  projectConfigBytes,
  readAppStateFile,
  readLanguagesFromRenderer,
  readMenuSnapshotSpellcheck,
  readSessionSpellingTruth,
  readSpellcheckToggleChecked,
  reopenUserPreferences,
  type SessionSpellingTruth,
  sameLanguageSet,
  seedExtraProject,
  seedProjectProfile,
  setLanguagesFromRenderer,
  setSpellcheckToggle,
  showUserPreferences,
} from './_helpers/settings-surface';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const LANGUAGE_WRITES_MOVE_THE_ENGINE = process.platform !== 'darwin';

function requireNonDefaultSelection(truth: SessionSpellingTruth): string[] {
  const desired = pickNonDefaultSelection(truth);
  if (desired === null) {
    throw new Error('the session reports no unselected language to write a new selection with');
  }
  return desired;
}

test.describe('Spelling settings — persistence and agreement on real Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('the on/off choice and the checking languages survive a relaunch on the same profile', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(220_000);
    const profile = seedProjectProfile('spellcheck-restart', { spellCheckEnabled: true });
    const first = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: [] });
      },
    });

    const configAfterOpen = projectConfigBytes(profile);
    const initial = await readSessionSpellingTruth(first.app);
    expect(initial.enabled).toBe(true);

    await setSpellcheckToggle(first.editor, false);
    await awaitEngineSpellcheckEnabled(first.app, false);

    const desired = requireNonDefaultSelection(initial);
    expect(await setLanguagesFromRenderer(first.editor, desired)).toMatchObject({ outcome: 'ok' });

    const applied = await readSessionSpellingTruth(first.app);
    expect(applied.enabled).toBe(false);
    if (LANGUAGE_WRITES_MOVE_THE_ENGINE) {
      expect(sameLanguageSet(applied.selected, desired)).toBe(true);
      expect(sameLanguageSet(applied.selected, initial.selected)).toBe(false);
    }
    expect(readAppStateFile(profile).spellCheckEnabled).toBe(false);

    await closeAppForRelaunch(first.app);

    const second = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, {
          home: profile.tmpHome,
          cleanupDirs: profile.cleanupDirs,
        });
      },
    });

    const restored = await readSessionSpellingTruth(second.app);
    expect(restored.enabled).toBe(false);
    expect(restored.selected).toEqual(applied.selected);
    expect(await readSpellcheckToggleChecked(second.editor)).toBe('false');

    expect(projectConfigBytes(profile)).toBe(configAfterOpen);
    expect(findAppStateFiles(profile.tmpHome)).toEqual([join(profile.userDataDir, 'state.json')]);
  });

  test('the choice reaches another project window in the same profile and never leaks into a separate profile', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(240_000);
    const profile = seedProjectProfile('spellcheck-shared', { spellCheckEnabled: true });
    const secondProject = seedExtraProject('spellcheck-shared');
    const { app, editor } = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: [secondProject] });
      },
    });

    const initial = await readSessionSpellingTruth(app);
    await setSpellcheckToggle(editor, false);
    await awaitEngineSpellcheckEnabled(app, false);
    const desired = requireNonDefaultSelection(initial);
    expect(await setLanguagesFromRenderer(editor, desired)).toMatchObject({ outcome: 'ok' });
    const applied = await readSessionSpellingTruth(app);

    await closeSettingsDialog(editor);
    await openProjectFromRecents(editor, secondProject);
    const other = await findEditorWindowForProject(app, secondProject);
    await openSettingsDialog(other);
    await showUserPreferences(other);

    expect(await readSpellcheckToggleChecked(other)).toBe('false');
    expect(await readLanguagesFromRenderer(other)).toEqual({
      outcome: 'ok',
      selected: applied.selected,
      available: applied.available,
    });
    expect((await readSessionSpellingTruth(app)).enabled).toBe(false);

    await closeAppForRelaunch(app);

    const isolated = seedProjectProfile('spellcheck-isolated');
    const fresh = await openSpellingSettings(isolated, {
      onLaunch: (launched) => {
        captureStderrFor(launched, {
          home: isolated.tmpHome,
          cleanupDirs: [...profile.cleanupDirs, ...isolated.cleanupDirs],
        });
      },
    });

    const freshTruth = await readSessionSpellingTruth(fresh.app);
    expect(freshTruth.enabled).toBe(true);
    expect(await readSpellcheckToggleChecked(fresh.editor)).toBe('true');
    expect(freshTruth.selected).toEqual(initial.selected);
    if (LANGUAGE_WRITES_MOVE_THE_ENGINE) {
      expect(sameLanguageSet(freshTruth.selected, applied.selected)).toBe(false);
    }
  });

  test('a language write in the same already-attached window leaves a chosen Off untouched', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(220_000);
    const profile = seedProjectProfile('spellcheck-off-hold', { spellCheckEnabled: true });
    const first = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: [] });
      },
    });

    const initial = await readSessionSpellingTruth(first.app);
    await setSpellcheckToggle(first.editor, false);
    await awaitEngineSpellcheckEnabled(first.app, false);

    const windowsBeforeWrite = first.app.windows().length;
    const desired = requireNonDefaultSelection(initial);
    expect(await setLanguagesFromRenderer(first.editor, desired)).toMatchObject({ outcome: 'ok' });
    expect(first.app.windows().length).toBe(windowsBeforeWrite);

    const afterWrite = await readSessionSpellingTruth(first.app);
    expect(afterWrite.enabled).toBe(false);
    expect(await readMenuSnapshotSpellcheck(first.editor)).toBe(false);
    expect(await applicationMenuSpellcheck(first.app, 'read')).toBe(false);
    if (LANGUAGE_WRITES_MOVE_THE_ENGINE) {
      expect(sameLanguageSet(afterWrite.selected, desired)).toBe(true);
    }

    await closeAppForRelaunch(first.app);

    const second = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, {
          home: profile.tmpHome,
          cleanupDirs: profile.cleanupDirs,
        });
      },
    });
    const restored = await readSessionSpellingTruth(second.app);
    expect(restored.enabled).toBe(false);
    expect(restored.selected).toEqual(afterWrite.selected);
  });

  test('the existing menu path and the settings switch never disagree about on/off', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(180_000);
    const profile = seedProjectProfile('spellcheck-menu-agree', { spellCheckEnabled: true });
    const { app, editor } = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });

    expect(await applicationMenuSpellcheck(app, 'read')).toBe(true);
    expect(await readSpellcheckToggleChecked(editor)).toBe('true');

    await applicationMenuSpellcheck(app, 'click');
    await awaitEngineSpellcheckEnabled(app, false);
    expect(await applicationMenuSpellcheck(app, 'read')).toBe(false);

    await reopenUserPreferences(editor);
    expect(await readSpellcheckToggleChecked(editor)).toBe('false');

    await setSpellcheckToggle(editor, true);
    await awaitEngineSpellcheckEnabled(app, true);
    expect(await applicationMenuSpellcheck(app, 'read')).toBe(true);
    expect(await readMenuSnapshotSpellcheck(editor)).toBe(true);
    expect(readAppStateFile(profile).spellCheckEnabled).toBe(true);
  });

  test('a stale Off in settings does not switch checking off when the user asks for On', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(180_000);
    const profile = seedProjectProfile('spellcheck-stale', { spellCheckEnabled: false });
    const { app, editor } = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });

    const toggle = editor.getByTestId('settings-spellcheck-toggle');
    expect(await readSpellcheckToggleChecked(editor)).toBe('false');
    await awaitEngineSpellcheckEnabled(app, false);

    await applicationMenuSpellcheck(app, 'click');
    await awaitEngineSpellcheckEnabled(app, true);
    expect(await toggle.getAttribute('aria-checked')).toBe('false');

    await toggle.click({ timeout: 15_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });

    expect((await readSessionSpellingTruth(app)).enabled).toBe(true);
    expect(await applicationMenuSpellcheck(app, 'read')).toBe(true);
    expect(readAppStateFile(profile).spellCheckEnabled).toBe(true);
  });

  test('an unsupported code and an empty selection are refused without changing stored state', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(180_000);
    const profile = seedProjectProfile('spellcheck-refuse');
    const { app, editor } = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });

    const before = await readSessionSpellingTruth(app);

    expect(await setLanguagesFromRenderer(editor, ['zz-NOPE'])).toEqual({
      outcome: 'failed',
      reason: 'unsupported-language',
    });
    expect(await readSessionSpellingTruth(app)).toEqual(before);

    expect(await setLanguagesFromRenderer(editor, [])).toEqual({
      outcome: 'failed',
      reason: 'empty-selection',
    });
    expect(await readSessionSpellingTruth(app)).toEqual(before);

    expect(await setLanguagesFromRenderer(editor, [...before.selected, 'zz-NOPE'])).toEqual({
      outcome: 'failed',
      reason: 'unsupported-language',
    });
    expect(await readSessionSpellingTruth(app)).toEqual(before);

    expect(readAppStateFile(profile).spellCheckEnabled).toBe(before.enabled);
  });
});
