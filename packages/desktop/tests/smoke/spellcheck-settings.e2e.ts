import { resolveDesktopTarget } from './_helpers/launch-desktop';
import { PLATFORM_SKIP_REASON, PLATFORM_SUPPORTED, SMOKE_ENABLED } from './_helpers/platform-gate';
import {
  awaitUserInterfaceLanguage,
  findEditorWindow,
  launchOnSeededProfile,
  openSettingsDialog,
  openSpellingSettings,
  pickNonDefaultSelection,
  readLanguagesFromRenderer,
  readSessionSpellingTruth,
  sameLanguageSet,
  seedProjectProfile,
  seedSessionSpellingLanguages,
  showUserPreferences,
} from './_helpers/settings-surface';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SELECTOR_RENDERS = process.platform !== 'darwin';

const LANGUAGE_ITEM_PREFIX = 'settings-spellcheck-language-item-';

test.describe('Spelling settings — real Electron surface', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('User Preferences opens on a seeded project window and shows the spelling controls this platform supports', async ({
    captureStderrFor,
  }) => {
    const profile = seedProjectProfile('spellcheck-open', { spellCheckEnabled: false });
    const { app, editor } = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });

    const toggle = editor.getByTestId('settings-spellcheck-toggle');
    await expect(toggle).toBeVisible({ timeout: 20_000 });

    const truth = await readSessionSpellingTruth(app);
    expect(truth.enabled).toBe(false);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    const languagesRow = editor.getByTestId('settings-spellcheck-languages-row');
    if (SELECTOR_RENDERS) await expect(languagesRow).toBeVisible({ timeout: 20_000 });
    else await expect(languagesRow).toHaveCount(0);

    await expect(editor.locator('[data-field="appearance.language"]')).toBeVisible();
  });

  test('the spelling settings report exactly the checking languages session.defaultSession holds', async ({
    captureStderrFor,
  }) => {
    const profile = seedProjectProfile('spellcheck-mirror');
    const app = await launchOnSeededProfile(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });
    const editor = await findEditorWindow(app);

    const initial = await readSessionSpellingTruth(app);
    if (SELECTOR_RENDERS) {
      const desired = pickNonDefaultSelection(initial);
      if (desired === null) {
        throw new Error(
          'the session reports no unselected language to seed a non-default set with',
        );
      }
      await seedSessionSpellingLanguages(app, desired);
      const applied = await readSessionSpellingTruth(app);
      expect(sameLanguageSet(applied.selected, desired)).toBe(true);
      expect(sameLanguageSet(applied.selected, initial.selected)).toBe(false);
    }

    await openSettingsDialog(editor);
    await showUserPreferences(editor);

    const truth = await readSessionSpellingTruth(app);
    const observed = await readLanguagesFromRenderer(editor);

    expect(observed).toEqual({
      outcome: 'ok',
      selected: truth.selected,
      available: truth.available,
    });

    if (!SELECTOR_RENDERS) return;

    await editor.getByTestId('settings-spellcheck-languages-trigger').click({ timeout: 20_000 });
    await expect(editor.getByTestId('settings-spellcheck-languages-list')).toBeVisible({
      timeout: 15_000,
    });
    const checkedIds = await editor
      .locator(`[data-testid^="${LANGUAGE_ITEM_PREFIX}"][aria-selected="true"]`)
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
    expect(checkedIds.map((id) => id.slice(LANGUAGE_ITEM_PREFIX.length)).sort()).toEqual(
      [...truth.selected].sort(),
    );
  });

  test('changing the interface language leaves the configured checking languages untouched', async ({
    captureStderrFor,
  }) => {
    const profile = seedProjectProfile('spellcheck-ui-locale');
    const { app, editor } = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });

    const row = editor.getByTestId('settings-spellcheck-row');
    await expect(row).toContainText('Check spelling while typing', { timeout: 20_000 });
    const before = await readSessionSpellingTruth(app);

    const combobox = editor.locator('[data-field="appearance.language"] [role="combobox"]');
    const spanish = editor.getByRole('option', { name: /español/i });
    await expect(async () => {
      if (!(await spanish.isVisible())) await combobox.click({ timeout: 5_000 });
      await spanish.click({ timeout: 5_000 });
      await expect(row).toContainText('Comprobar la ortografía al escribir', { timeout: 8_000 });
    }).toPass({ timeout: 25_000 });

    await awaitUserInterfaceLanguage(profile, 'es');

    const after = await readSessionSpellingTruth(app);
    expect(after.selected).toEqual(before.selected);
    expect(after.enabled).toBe(before.enabled);
  });
});
