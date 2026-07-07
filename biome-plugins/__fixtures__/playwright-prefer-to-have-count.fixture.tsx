/**
 * Fixture for `playwright-prefer-to-have-count.grit`.
 *
 * 3 positive cases (one-shot count reads — plugin MUST fire) paired with
 * 5 negative cases (web-first / legitimately different shapes — plugin
 * must NOT fire). The fixture-file test asserts the diagnostic count with
 * exact equality (`toBe(3)`) so both weakened-pattern and widened-pattern
 * drift fail the gate.
 *
 * Deliberately NOT linted by the main `bun run lint` pass (biome-plugins/
 * is outside the lint paths); only the scoped override in biome.jsonc
 * reaches it, via the fixture-file test.
 */

declare const expect: any;
declare const page: any;

async function positives() {
  const rows = page.locator('[role="treeitem"]');
  // P1: one-shot count + toBe — the canonical banned shape.
  expect(await rows.count()).toBe(0);
  // P2: same shape, different matcher — still a no-retry snapshot.
  expect(await page.locator('.pill').count()).toEqual(1);
  // P3: comparison matcher on a one-shot count read.
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
}

async function negatives() {
  const rows = page.locator('[role="treeitem"]');
  // N1: the web-first replacement — must NOT fire.
  await expect(rows).toHaveCount(3);
  // N2: expect.poll over a count probe is auto-retrying — must NOT fire.
  await expect.poll(async () => rows.count()).toBe(4);
  // N3: a bare count read without an expect wrapper — must NOT fire.
  const n = await rows.count();
  void n;
  // N4: an expect over a different awaited method — must NOT fire.
  expect(await rows.boundingBox()).toBeTruthy();
  // N5: count read assigned to a variable, then asserted in a separate
  // statement — the documented two-statement escape hatch (GritQL cannot
  // correlate across statements); must NOT fire.
  const c = await rows.count();
  expect(c).toBe(2);
}

export { negatives, positives };
