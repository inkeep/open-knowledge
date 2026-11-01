import { randomUUID } from 'node:crypto';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

for (const timing of ['during', 'after']) {
  test(`Escape closes find/replace ${timing} tooltip exit`, async ({ page, api }, testInfo) => {
    const docName = `test-find-escape-${randomUUID()}`;
    await api.seedDocs([{ name: docName, markdown: '# Find\n\nneedle one needle two.' }]);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);

    const editor = page.locator('.ProseMirror:not(.composer-prosemirror)');
    await expect(editor).toContainText('needle one needle two.');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+F' : 'Control+H');

    const bar = page.getByTestId('find-replace-bar');
    const find = bar.getByRole('textbox', { name: 'Find', exact: true });
    await expect(find).toBeFocused();
    await find.fill('needle');
    await expect(bar).toContainText('1 / 2');
    await bar.getByRole('textbox', { name: 'Replace', exact: true }).fill('marker');

    const replaceAll = bar.getByRole('button', { name: 'Replace all matches' });
    await replaceAll.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Replace all matches');

    const tooltip = page.locator('[data-slot="tooltip-content"]');
    const exit = await tooltip.evaluateHandle((element) => {
      const animations: Animation[] = [];
      const pause = (event: Event) => {
        if (event.target !== element || element.getAttribute('data-state') !== 'closed') return;
        for (const animation of element.getAnimations()) {
          animation.pause();
          animations.push(animation);
        }
      };
      element.addEventListener('animationstart', pause);
      return { element, animations, pause };
    });

    async function finishTooltipExit() {
      await exit.evaluate(({ animations }) => {
        for (const animation of animations) animation.play();
      });
      await expect(tooltip).toHaveCount(0);
    }

    try {
      await replaceAll.click();
      await expect(editor).toContainText('marker one marker two.');
      await expect(replaceAll).toBeDisabled();
      await expect
        .poll(() =>
          exit.evaluate(
            ({ element, animations }, detachedAllowed) =>
              (detachedAllowed && !element.isConnected) ||
              (element.isConnected &&
                element.getAttribute('data-state') === 'closed' &&
                animations.length > 0 &&
                animations.every((animation) => animation.playState === 'paused')),
            timing === 'after',
          ),
        )
        .toBe(true);

      if (timing === 'after') await finishTooltipExit();
      await testInfo.attach('tooltip-before-escape', {
        body: JSON.stringify(
          await exit.evaluate(({ element, animations }) => ({
            connected: element.isConnected,
            state: element.getAttribute('data-state'),
            animations: animations.map((animation) => animation.playState),
            focusedTag: document.activeElement?.tagName,
          })),
        ),
        contentType: 'application/json',
      });
      await page.keyboard.press('Escape');
      if (timing === 'during') await finishTooltipExit();

      await expect(bar).toBeHidden();
      await expect(editor).toBeFocused();
    } finally {
      await exit.evaluate(({ element, animations, pause }) => {
        element.removeEventListener('animationstart', pause);
        for (const animation of animations) animation.play();
      });
      await exit.dispose();
    }
  });
}
