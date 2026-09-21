import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, acpCatalogBody, expect, test } from './_helpers';

const WYSIWYG_BODY = '.editor-doc-scroll .ProseMirror:not(.composer-prosemirror)';
const COMPOSER_CARD = '[data-testid="bottom-composer"] > div';
const ATTACH = '[data-testid="ask-ai-attach-files"]';
const COMPOSER_INPUT = '.composer-prosemirror';
const PICKER = '[data-testid="ask-ai-agent-group"]';
const SUGGESTION_PHRASE = '[data-testid="ask-ai-composer-placeholder"] [data-rotating-placeholder]';

const FIRST_PAINT_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 15_000;
const CENTRE_TOLERANCE_PX = 1;

const WHY = [
  'the attach button, the prompt text and the agent picker no longer share a centre line.',
  '',
  'Three production knobs place that line, and reverting any one of them alone reopens the',
  'spread past this tolerance:',
  '  1. size="icon" on AttachFilesButton in BottomComposer, so it matches the picker height',
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
  test('the attach button, the prompt text and the agent picker share one centre line', async ({
    page,
    api,
  }) => {
    await openAskAiComposer(page, api);
    await expect(
      page.locator(ATTACH).first(),
      'the composer rendered without its attach control, so the row this test measures is not the ' +
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
            ({ attachSel, inputSel, pickerSel }) => {
              const resolve = (selector: string): HTMLElement => {
                const found = document.querySelector(selector);
                if (!(found instanceof HTMLElement)) {
                  throw new Error(`no painted element for ${selector}`);
                }
                return found;
              };
              const attach = resolve(attachSel);
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
              const centres = [boxCentre(attach), lineCentre(input), boxCentre(picker)];
              return Math.max(...centres) - Math.min(...centres);
            },
            { attachSel: ATTACH, inputSel: COMPOSER_INPUT, pickerSel: PICKER },
          ),
        { message: WHY, timeout: SETTLE_TIMEOUT_MS },
      )
      .toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
  });

  test('the empty composer paints its suggestion through the overlay pseudo-element', async ({
    page,
    api,
  }) => {
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
  });
});
