import { randomUUID } from 'node:crypto';
import { expect, test } from './_helpers';

const PARAS = [
  'Alpha paragraph zero.',
  'Bravo paragraph one.',
  'Charlie paragraph two.',
  'Delta paragraph three.',
  'Echo paragraph four.',
  'Foxtrot paragraph five.',
  'Golf paragraph six.',
  'Hotel paragraph seven.',
];
const SEED = PARAS.join('\n\n');

interface FlashSample {
  inlineDeco: string[];
  edgeWashed: Array<{ i: number; text: string }>;
}

async function sampleFlash(page: import('@playwright/test').Page): Promise<FlashSample> {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    const kids = pm ? [...pm.children] : [];
    return {
      inlineDeco: [...document.querySelectorAll('.ok-agent-insert-flash')].map(
        (e) => e.textContent ?? '',
      ),
      edgeWashed: kids
        .map((el, i) => ({
          i,
          text: (el.textContent ?? '').slice(0, 32),
          anim: getComputedStyle(el).animationName,
        }))
        .filter((r) => r.anim === 'agent-flash')
        .map(({ i, text }) => ({ i, text })),
    };
  });
}

test('an agent write flashes the paragraph it changed, not the ones at the document edge', async ({
  page,
  api,
}) => {
  const docName = `agent-flash-placement-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, `${SEED}\n`);

  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(
    () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('Hotel'),
    null,
    { timeout: 10_000 },
  );
  await expect
    .poll(async () => (await sampleFlash(page)).inlineDeco.length, {
      timeout: 15_000,
      message: 'the seed write kept a flash on screen, so the next one cannot be attributed',
    })
    .toBe(0);

  const edited = SEED.replace('Delta paragraph three.', 'Delta paragraph three EDITED-XYZ.');
  await api.replaceDoc(docName, `${edited}\n`);
  await page.waitForFunction(
    () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('EDITED-XYZ'),
    null,
    { timeout: 10_000 },
  );

  await expect
    .poll(async () => (await sampleFlash(page)).inlineDeco.join('|'), { timeout: 5_000 })
    .toContain('EDITED-XYZ');

  const sample = await sampleFlash(page);
  expect(sample.inlineDeco.join('|'), 'the flash must cover the changed paragraph').toContain(
    'Delta paragraph three EDITED-XYZ.',
  );
  expect(
    sample.inlineDeco.join('|'),
    'the flash must not spill onto untouched paragraphs',
  ).not.toContain('Hotel paragraph seven.');
  expect(sample.edgeWashed, 'no block may be washed for sitting at the document edge').toEqual([]);
});
