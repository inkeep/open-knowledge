import type { Page } from '@playwright/test';
import { resolveDesktopTarget } from './_helpers/launch-desktop';
import { PLATFORM_SKIP_REASON, PLATFORM_SUPPORTED, SMOKE_ENABLED } from './_helpers/platform-gate';
import {
  addLanguageInSelector,
  closeSettingsDialog,
  type EditorSelectionSnapshot,
  editorBody,
  findEditorWindow,
  launchOnSeededProfile,
  openProjectDocument,
  openSettingsDialog,
  openSpellingSettings,
  pickNonDefaultSelection,
  readEditorSelectionSnapshot,
  readSessionSpellingTruth,
  seedProjectProfile,
  setSpellcheckToggle,
  showUserPreferences,
} from './_helpers/settings-surface';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SELECTOR_RENDERS = process.platform !== 'darwin';

const SEEDED_DOC = 'note';

const MARKER = 'undisturbed';

const STAMP = 'pre-settings';

const CONTENT_HOLD_MS = 1_000;

const PRESS_INTERVAL_MS = 33;

type StampCarrier = Record<string, unknown>;

const STAMP_KEY = '__okSpellingProbeStamp';

async function stampSurfaces(editor: Page): Promise<void> {
  await editorBody(editor).evaluate(
    (element, { key, value }) => {
      (element as unknown as StampCarrier)[key] = value;
      (window as unknown as StampCarrier)[key] = value;
    },
    { key: STAMP_KEY, value: STAMP },
  );
}

interface SurfaceStamps {
  readonly editable: string | null;
  readonly host: string | null;
}

async function readStamps(editor: Page): Promise<SurfaceStamps> {
  return editorBody(editor).evaluate((element, key) => {
    const read = (carrier: unknown): string | null => {
      const value = (carrier as StampCarrier)[key];
      return typeof value === 'string' ? value : null;
    };
    return { editable: read(element), host: read(window) };
  }, STAMP_KEY);
}

async function waitForEditorSelection(
  editor: Page,
  expected: string,
  timeoutMs = 15_000,
): Promise<void> {
  await expect
    .poll(() => readEditorSelectionSnapshot(editor), { timeout: timeoutMs })
    .toEqual({ held: true, text: expected } satisfies EditorSelectionSnapshot);
}

async function selectMarkerBackwards(editor: Page, timeoutMs = 30_000): Promise<void> {
  await expect(async () => {
    await editor.keyboard.press('End');
    for (let i = 0; i < MARKER.length; i++) {
      await editor.keyboard.press('Shift+ArrowLeft', { delay: PRESS_INTERVAL_MS });
    }
    await waitForEditorSelection(editor, MARKER, 3_000);
  }).toPass({ timeout: timeoutMs });
}

async function refocusEditable(editor: Page): Promise<void> {
  await editorBody(editor).evaluate((element) => {
    (element as HTMLElement).focus();
  });
}

async function readEditorContent(editor: Page): Promise<string> {
  return (await editorBody(editor).textContent()) ?? '';
}

async function expectEditorContentHolds(
  editor: Page,
  expected: string,
  windowMs: number,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    expect(await readEditorContent(editor)).toBe(expected);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(await readEditorContent(editor)).toBe(expected);
}

test.describe('Spelling settings — platform presentation and editor non-interference', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('this desktop platform shows exactly the spelling controls it supports, beside a working interface Language control', async ({
    captureStderrFor,
  }) => {
    const profile = seedProjectProfile('spellcheck-presentation');
    const { editor } = await openSpellingSettings(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });

    await expect(editor.getByTestId('settings-spellcheck-toggle')).toBeVisible({ timeout: 20_000 });

    const languagesRow = editor.getByTestId('settings-spellcheck-languages-row');
    if (SELECTOR_RENDERS) await expect(languagesRow).toBeVisible({ timeout: 20_000 });
    else await expect(languagesRow).toHaveCount(0);

    const combobox = editor.locator('[data-field="appearance.language"] [role="combobox"]');
    await expect(combobox).toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      if (!(await editor.getByRole('listbox').isVisible())) {
        await combobox.click({ timeout: 5_000 });
      }
      await expect(editor.getByRole('option', { name: /english/i })).toBeVisible({
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000 });
    await editor.keyboard.press('Escape');
  });

  test('using the spelling controls leaves the open document, its selection and its undo history intact', async ({
    captureStderrFor,
  }) => {
    const profile = seedProjectProfile('spellcheck-noninterference');
    const app = await launchOnSeededProfile(profile, {
      onLaunch: (launched) => {
        captureStderrFor(launched, { home: profile.tmpHome, cleanupDirs: profile.cleanupDirs });
      },
    });
    const editor = await findEditorWindow(app);

    await openProjectDocument(editor, SEEDED_DOC);

    const body = editorBody(editor);
    await body.locator('p').filter({ hasText: 'Prose for the checker' }).click();
    await editor.keyboard.press('End');
    await editor.keyboard.type(` ${MARKER}`);
    await expect(body).toContainText(MARKER, { timeout: 20_000 });

    const contentBefore = await readEditorContent(editor);

    await selectMarkerBackwards(editor);

    await stampSurfaces(editor);

    await openSettingsDialog(editor);
    await showUserPreferences(editor);
    await setSpellcheckToggle(editor, false);
    await setSpellcheckToggle(editor, true);

    if (SELECTOR_RENDERS) {
      const truth = await readSessionSpellingTruth(app);
      const desired = pickNonDefaultSelection(truth);
      const added = desired?.find((code) => !truth.selected.includes(code));
      if (added === undefined) {
        throw new Error('the session reports no unselected language to add through the selector');
      }
      await addLanguageInSelector(editor, added);
    }

    await closeSettingsDialog(editor);

    expect(await readStamps(editor)).toEqual({ editable: STAMP, host: STAMP });

    await expectEditorContentHolds(editor, contentBefore, CONTENT_HOLD_MS);

    await refocusEditable(editor);
    await waitForEditorSelection(editor, MARKER);

    await editor.keyboard.press('ControlOrMeta+z');
    await expect(body).not.toContainText(MARKER, { timeout: 20_000 });
  });
});
