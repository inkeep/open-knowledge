import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, toggleMode, waitForActiveProviderSynced } from './_helpers';

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return (await r.json()) as T;
}

async function pageNames(baseURL: string): Promise<string[]> {
  const body = await json<{ pages: Array<{ docName: string }> }>(`${baseURL}/api/pages`);
  return body.pages.map((p) => p.docName).sort();
}

async function docContent(baseURL: string, docName: string): Promise<string> {
  const body = await json<{ content: string }>(
    `${baseURL}/api/document?docName=${encodeURIComponent(docName)}`,
  );
  return body.content;
}

async function readDoc(
  baseURL: string,
  docName: string,
): Promise<{ status: number; content: string | null }> {
  const r = await fetch(`${baseURL}/api/document?docName=${encodeURIComponent(docName)}`);
  if (!r.ok) return { status: r.status, content: null };
  const body = (await r.json()) as { content: string };
  return { status: r.status, content: body.content };
}

async function forwardTargets(baseURL: string, docName: string): Promise<string[]> {
  const body = await json<{ forwardLinks: Array<{ kind: string; docName?: string }> }>(
    `${baseURL}/api/forward-links?docName=${encodeURIComponent(docName)}`,
  );
  return body.forwardLinks
    .filter((l) => l.kind === 'doc' && typeof l.docName === 'string')
    .map((l) => l.docName as string)
    .sort();
}

async function backlinkSources(baseURL: string, docName: string): Promise<string[]> {
  const body = await json<{ backlinks: Array<{ source: string }> }>(
    `${baseURL}/api/backlinks?docName=${encodeURIComponent(docName)}`,
  );
  return body.backlinks.map((b) => b.source).sort();
}

async function expectExactHash(page: Page, docName: string, label: string): Promise<void> {
  await page
    .waitForFunction(
      (d) => {
        const h = decodeURIComponent(window.location.hash);
        return h === `#/${d}` || h.startsWith(`#/${d}#`);
      },
      docName,
      { timeout: 20_000 },
    )
    .catch(async () => {
      throw new Error(
        `${label}: expected hash #/${docName}, got ${decodeURIComponent(page.url().split('#').slice(1).join('#') ? `#${page.url().split('#').slice(1).join('#')}` : '')}`,
      );
    });
}

async function openDoc(page: Page, docName: string): Promise<void> {
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.waitForSelector(WYSIWYG);
  await page.keyboard.press('Escape');
  await page.locator(`${WYSIWYG} h1`).first().click();
}

test('QA-019: exact / one-suffix-stripped / original-fuzzy precedence agrees across every channel', async ({
  page,
  api,
  baseURL,
  workerServer,
}) => {
  test.setTimeout(240_000);
  const K = randomUUID().slice(0, 8);
  const SRC = `src-${K}`;
  const PLAIN = `d1-${K}/x`;
  const DOTTED = `d1-${K}/x.md`;
  const BETA = `notes-${K}/beta`;
  const DECOY = `notes-${K}/beta-md`;
  const FUZZ = `sub-${K}/q.md`;
  const MDX = `mx-${K}/page`;
  const INDEX = `idx-${K}/index`;
  const MISS = `missing-${K}`;

  const corpus = [
    `[[${DOTTED}]]`,
    `[[${DOTTED}.md]]`,
    `[[${PLAIN}]]`,
    `[[${BETA}.md]]`,
    `[[${BETA}.md#intro|Beta Alias]]`,
    '[[q.md]]',
    `[[${MDX}.mdx]]`,
    `[[idx-${K}]]`,
    '[[BETA]]',
    `[[${MISS}]]`,
  ];

  await api.seedDocs([
    { name: `${PLAIN}.md`, markdown: `# X Plain\n\nmarker MKPLAIN${K}\n` },
    {
      name: `${BETA}.md`,
      markdown: `# Beta\n\nmarker MKBETA${K}\n\n## intro\n\nIntro body.\n`,
    },
    { name: `${DECOY}.md`, markdown: `# Beta Decoy\n\nmarker MKBETAMD${K}\n` },
    { name: `${MDX}.mdx`, markdown: `# Page Mdx\n\nmarker MKMDX${K}\n` },
    { name: `${INDEX}.md`, markdown: `# Index\n\nmarker MKINDEX${K}\n` },
    {
      name: `${SRC}.md`,
      markdown: `# Source\n\n${corpus.map((l, i) => `L${i + 1} ${l}`).join('\n\n')}\n`,
    },
  ]);

  const dottedFiles: Array<[string, string]> = [
    [`d1-${K}/x.md.md`, `# X Dotted\n\nmarker MKDOTTED${K}\n`],
    [`sub-${K}/q.md.md`, `# Q Dotted\n\nmarker MKFUZZ${K}\n`],
  ];
  for (const [rel, markdown] of dottedFiles) {
    const full = join(workerServer.contentDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, markdown, 'utf-8');
  }
  expect(existsSync(join(workerServer.contentDir, `sub-${K}/q.md`))).toBe(false);
  const rescan = await fetch(`${baseURL}/api/test-rescan-files`, { method: 'POST' });
  expect(rescan.ok).toBe(true);
  const backlinkRescan = await fetch(`${baseURL}/api/test-rescan-backlinks`, { method: 'POST' });
  expect(backlinkRescan.ok).toBe(true);

  await expect
    .poll(() => pageNames(baseURL), { timeout: 30_000 })
    .toEqual(expect.arrayContaining([SRC, PLAIN, DOTTED, BETA, DECOY, FUZZ, MDX, INDEX]));
  const names = await pageNames(baseURL);
  expect(names).not.toContain('q');
  expect(names).not.toContain(`sub-${K}/q`);
  expect(await docContent(baseURL, PLAIN)).toContain(`MKPLAIN${K}`);
  const dottedReadBack = await readDoc(baseURL, DOTTED);
  const fuzzReadBack = await readDoc(baseURL, FUZZ);
  expect(dottedReadBack.status).toBe(200);
  expect(dottedReadBack.content).toContain(`MKDOTTED${K}`);
  expect(dottedReadBack.content).not.toContain(`MKPLAIN${K}`);
  expect(fuzzReadBack.status).toBe(200);
  expect(fuzzReadBack.content).toContain(`MKFUZZ${K}`);
  expect(await docContent(baseURL, `${DOTTED}.md`)).toContain(`MKDOTTED${K}`);

  const expectedTargets = [PLAIN, DOTTED, BETA, FUZZ, MDX, INDEX].sort();
  await expect
    .poll(() => forwardTargets(baseURL, SRC), { timeout: 30_000 })
    .toEqual(expect.arrayContaining(expectedTargets));
  const actualTargets = await forwardTargets(baseURL, SRC);
  expect(actualTargets.filter((t) => !expectedTargets.includes(t)).sort()).toEqual(
    [MISS].filter((m) => actualTargets.includes(m)),
  );
  expect(actualTargets).not.toContain(DECOY);
  expect(await backlinkSources(baseURL, DECOY)).toEqual([]);
  for (const target of expectedTargets) {
    expect(await backlinkSources(baseURL, target), `backlinks of ${target}`).toEqual([SRC]);
  }

  const deadLinks = await json<{ deadLinks: Array<{ target: string }> }>(
    `${baseURL}/api/dead-links?sourceDocName=${encodeURIComponent(SRC)}`,
  );
  expect(deadLinks.deadLinks.map((d) => d.target).sort()).toEqual([MISS]);

  const writeTime = await fetch(`${baseURL}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: SRC,
      markdown: `# Source\n\n${corpus.map((l, i) => `L${i + 1} ${l}`).join('\n\n')}\n`,
      position: 'replace',
    }),
  });
  const writeTimeBody = JSON.stringify(await writeTime.json());
  expect(writeTime.status).toBe(200);

  const richCases: Array<{ label: string; selector: string; doc: string; marker: string }> = [
    { label: 'L1 exact-dotted-beats-stripped', selector: DOTTED, doc: DOTTED, marker: 'MKDOTTED' },
    { label: 'L2 strip-exactly-one', selector: `${DOTTED}.md`, doc: DOTTED, marker: 'MKDOTTED' },
    { label: 'L3 plain-exact', selector: PLAIN, doc: PLAIN, marker: 'MKPLAIN' },
    { label: 'L4 suffix-strip-over-decoy', selector: `${BETA}.md`, doc: BETA, marker: 'MKBETA' },
    {
      label: 'L6 original-fuzzy-after-stripped-miss',
      selector: 'q.md',
      doc: FUZZ,
      marker: 'MKFUZZ',
    },
    { label: 'L7 mdx-strip', selector: `${MDX}.mdx`, doc: MDX, marker: 'MKMDX' },
    { label: 'L9 case-insensitive-basename', selector: 'BETA', doc: BETA, marker: 'MKBETA' },
  ];

  const observedHashes: Record<string, string> = {};
  for (const c of richCases) {
    await openDoc(page, SRC);
    const chip = page.locator(`${WYSIWYG} [data-wiki-link][data-target="${c.selector}"]`).first();
    await expect(chip, `${c.label}: chip present`).toBeVisible({ timeout: 20_000 });
    await chip.click();
    await expectExactHash(page, c.doc, c.label);
    await expect(page.locator(WYSIWYG), `${c.label}: landed marker`).toContainText(
      `${c.marker}${K}`,
      { timeout: 20_000 },
    );
    observedHashes[c.label] = await page.evaluate(() => decodeURIComponent(window.location.hash));
  }

  await openDoc(page, SRC);
  const folderChip = page.locator(`${WYSIWYG} [data-wiki-link][data-target="idx-${K}"]`).first();
  await expect(folderChip, 'L8 folder-index chip present').toBeVisible({ timeout: 20_000 });
  await folderChip.click();
  await expectExactHash(page, `idx-${K}`, 'L8 folder-index app click');
  observedHashes['L8 folder-index'] = await page.evaluate(() =>
    decodeURIComponent(window.location.hash),
  );
  await openDoc(page, INDEX);
  await expect(page.locator(WYSIWYG), 'L8 resolver target is a real document').toContainText(
    `MKINDEX${K}`,
    { timeout: 20_000 },
  );

  await openDoc(page, SRC);
  const aliasChip = page.locator(`${WYSIWYG} [data-wiki-link]`).filter({ hasText: 'Beta Alias' });
  await expect(aliasChip, 'L5 alias chip present').toBeVisible({ timeout: 20_000 });
  await aliasChip.click();
  await expectExactHash(page, BETA, 'L5 alias+heading');
  await expect(page.locator(WYSIWYG)).toContainText(`MKBETA${K}`, { timeout: 20_000 });
  const aliasHash = page.url();

  const missChip = page.locator(`${WYSIWYG} [data-wiki-link][data-target="${MISS}"]`);

  await openDoc(page, SRC);
  await expect(missChip).toBeVisible({ timeout: 20_000 });
  await toggleMode(page, 'source');
  const sourceLinks = page.locator('.cm-content .cm-wiki-link');
  await expect(sourceLinks).toHaveCount(corpus.length, { timeout: 20_000 });
  const brokenLinks = page.locator('.cm-content .cm-wiki-link-broken');
  await expect(brokenLinks).toHaveCount(1, { timeout: 20_000 });
  await expect(brokenLinks.first()).toContainText(MISS);

  const dottedSourceLink = page
    .locator('.cm-content .cm-wiki-link')
    .filter({ hasText: DOTTED })
    .first();
  await expect(dottedSourceLink).toBeVisible({ timeout: 20_000 });
  const openedPromise = page.context().waitForEvent('page', { timeout: 20_000 });
  await dottedSourceLink.click({ modifiers: ['ControlOrMeta'] });
  const opened = await openedPromise;
  await expectExactHash(opened, DOTTED, 'source ctrl-click on the exact dotted identity');
  await waitForActiveProviderSynced(opened);
  await toggleMode(opened, 'wysiwyg');
  await expect(opened.locator(WYSIWYG)).toContainText(`MKDOTTED${K}`, { timeout: 20_000 });
  await expect(opened.locator(WYSIWYG)).not.toContainText(`MKPLAIN${K}`);
  await opened.close();

  process.stdout.write(
    `QA019-OBSERVED ${JSON.stringify({
      K,
      forwardTargets: actualTargets,
      deadLinks: deadLinks.deadLinks.map((d) => d.target),
      aliasHash,
      observedHashes,
      dottedReadBack,
      fuzzReadBack,
      writeTimeBody: writeTimeBody.slice(0, 900),
      srcBytes: await docContent(baseURL, SRC),
    })}\n`,
  );
});
