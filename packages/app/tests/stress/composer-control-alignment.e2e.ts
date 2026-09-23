import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, acpCatalogBody, expect, test } from './_helpers';

const WYSIWYG_BODY = '.editor-doc-scroll .ProseMirror:not(.composer-prosemirror)';
const COMPOSER_CARD = '[data-testid="bottom-composer"] > div';
const ADD_TO_PROMPT = '[data-testid="ask-ai-add-to-prompt"]';
const COMPOSER_INPUT = '.composer-prosemirror';
const PICKER = '[data-testid="ask-ai-agent-group"]';
const SUGGESTION_PHRASE = '[data-testid="ask-ai-composer-placeholder"] [data-rotating-placeholder]';

const FIRST_PAINT_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 15_000;
const CENTRE_TOLERANCE_PX = 1;
const PLACEHOLDER_OPTICAL_LIFT_PX = 1;
const PLACEHOLDER_POSITION_TOLERANCE_PX = 0.25;

const WHY = [
  'the add-to-prompt button, the prompt text and the agent picker no longer share a centre line.',
  '',
  'Three production knobs place that line, and reverting any one of them alone reopens the',
  'spread past this tolerance:',
  '  1. size="icon" on ComposerAddMenu in BottomComposer, so it matches the picker height',
  '  2. min-h-8 flex flex-col justify-center on the prompt column, giving the first line box',
  '     the control height while going inert once the input grows past one line',
  '  3. padding-bottom: 0.25rem on .ProseMirror.composer-prosemirror, which makes the input box',
  '     symmetric — with 0 it is taller above the glyphs than below, so aligning boxes cannot',
  '     align what a reader sees',
  '',
  'The row is items-end so the buttons stay beside the last line of a grown prompt, which means',
  'equal heights are what produce equal centres. Only a browser tier reads the compiled',
  'stylesheet: the jsdom suite mocks the input and loads no CSS, so nothing there can see this.',
].join('\n');

async function openAskAiComposer(page: Page, api: ApiHelpers): Promise<void> {
  const docName = `composer-alignment-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: `${docName}.md`, markdown: 'Alignment fixture.\n' }]);
  await page.route('**/api/installed-agents', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ claude: true }),
    }),
  );
  await page.route('**/api/acp/catalog', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(acpCatalogBody([{ id: 'alignment-agent', name: 'Alignment Agent' }])),
    }),
  );

  await page.goto(`/#/${docName}`);
  await expect(page.locator(WYSIWYG_BODY).first()).toBeVisible({
    timeout: FIRST_PAINT_TIMEOUT_MS,
  });
  await expect(page.locator(COMPOSER_CARD).first()).toBeVisible({
    timeout: FIRST_PAINT_TIMEOUT_MS,
  });
}

test.describe('Ask AI composer control alignment', () => {
  test('the mention action returns keyboard focus to the composer', async ({ page, api }) => {
    await openAskAiComposer(page, api);

    const composer = page.locator(COMPOSER_INPUT).first();
    const menu = page.locator('[data-composer-portal]');
    await page.locator(ADD_TO_PROMPT).first().click();
    await expect(menu).toBeVisible();
    await page.getByRole('menuitem', { name: 'Mention a page' }).click();

    await expect(menu).toHaveCount(0);
    await expect(composer).toBeFocused();
    await page.keyboard.type('r');
    await expect(composer).toContainText('@r');
  });

  test('the add-to-prompt button, the prompt text and the agent picker share one centre line', async ({
    page,
    api,
  }) => {
    await openAskAiComposer(page, api);
    await expect(
      page.locator(ADD_TO_PROMPT).first(),
      'the composer rendered without its add-to-prompt control, so the row this test measures is not the ' +
        'three-control row it exists to pin',
    ).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT_MS });
    await expect(page.locator(COMPOSER_INPUT).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await expect(page.locator(PICKER).first()).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT_MS });

    await expect
      .poll(
        () =>
          page.evaluate(
            ({ addToPromptSel, inputSel, pickerSel }) => {
              const resolve = (selector: string): HTMLElement => {
                const found = document.querySelector(selector);
                if (!(found instanceof HTMLElement)) {
                  throw new Error(`no painted element for ${selector}`);
                }
                return found;
              };
              const addToPrompt = resolve(addToPromptSel);
              const input = resolve(inputSel);
              const picker = resolve(pickerSel);
              const boxCentre = (el: HTMLElement): number => {
                const rect = el.getBoundingClientRect();
                return rect.top + rect.height / 2;
              };
              const lineCentre = (el: HTMLElement): number => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return (
                  rect.top +
                  Number.parseFloat(style.paddingTop) +
                  Number.parseFloat(style.lineHeight) / 2
                );
              };
              const centres = [boxCentre(addToPrompt), lineCentre(input), boxCentre(picker)];
              return Math.max(...centres) - Math.min(...centres);
            },
            { addToPromptSel: ADD_TO_PROMPT, inputSel: COMPOSER_INPUT, pickerSel: PICKER },
          ),
        { message: WHY, timeout: SETTLE_TIMEOUT_MS },
      )
      .toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
  });

  test('the empty composer paints and optically centers its suggestion', async ({ page, api }) => {
    await openAskAiComposer(page, api);

    await expect
      .poll(
        () =>
          page.evaluate((selector) => {
            const phrase = document.querySelector(selector);
            if (!(phrase instanceof HTMLElement)) return 'no overlay phrase element';
            const attribute = phrase.getAttribute('data-rotating-placeholder') ?? '';
            const painted = getComputedStyle(phrase, '::before').content;
            return attribute !== '' && painted === JSON.stringify(attribute)
              ? 'painted'
              : `painted ${painted} for ${JSON.stringify(attribute)}`;
          }, SUGGESTION_PHRASE),
        {
          message:
            'the suggestion overlay painted no text: its ::before content no longer resolves to ' +
            'the phrase attribute, so the composer shows an empty placeholder',
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBe('painted');

    await expect
      .poll(
        () =>
          page.evaluate(
            ({ addToPromptSel, phraseSel, opticalLift }) => {
              const addToPrompt = document.querySelector(addToPromptSel);
              const phrase = document.querySelector(phraseSel);
              if (!(addToPrompt instanceof HTMLElement) || !(phrase instanceof HTMLElement)) {
                return Number.POSITIVE_INFINITY;
              }
              const addToPromptRect = addToPrompt.getBoundingClientRect();
              const phraseRect = phrase.getBoundingClientRect();
              const addToPromptCentre = addToPromptRect.top + addToPromptRect.height / 2;
              const phraseCentre = phraseRect.top + phraseRect.height / 2;
              return Math.abs(addToPromptCentre - phraseCentre - opticalLift);
            },
            {
              addToPromptSel: ADD_TO_PROMPT,
              phraseSel: SUGGESTION_PHRASE,
              opticalLift: PLACEHOLDER_OPTICAL_LIFT_PX,
            },
          ),
        {
          message:
            'the placeholder lost its one-pixel optical lift and appears low beside the add-to-prompt control',
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBeLessThanOrEqual(PLACEHOLDER_POSITION_TOLERANCE_PX);
  });
});
