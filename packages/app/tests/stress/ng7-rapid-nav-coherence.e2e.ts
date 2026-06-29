import { randomUUID } from 'node:crypto';
import { expect, filterCriticalErrors, type LogEntry, test } from './_helpers';

test.describe('NG7 Pattern D — rapid-nav coherence', () => {
  test('rapid A→B nav does not leak DOM, error, or stall', async ({ page, api }) => {
    const docA = `ng7-rapidnav-a-${randomUUID().slice(0, 8)}`;
    const docB = `ng7-rapidnav-b-${randomUUID().slice(0, 8)}`;
    const filler = 'Filler paragraph for cold-mount observability. '.repeat(20);
    const bodyA = `# ${docA}\n\nUnique-A-marker-${docA}\n\n${filler}`;
    const bodyB = `# ${docB}\n\nUnique-B-marker-${docB}\n\n${filler}`;
    await api.seedDocs([
      { name: docA, markdown: bodyA },
      { name: docB, markdown: bodyB },
    ]);

    const logs: LogEntry[] = [];
    page.on('console', (m) => {
      const loc = m.location();
      logs.push({ type: m.type(), text: m.text(), url: loc.url, line: loc.lineNumber });
    });
    page.on('pageerror', (e) => logs.push({ type: 'uncaught', text: e.message }));

    await page.goto('/');

    const aRow = page.getByRole('treeitem', { name: `${docA}.md`, exact: true });
    const bRow = page.getByRole('treeitem', { name: `${docB}.md`, exact: true });
    await expect(aRow).toBeVisible({ timeout: 30_000 });
    await expect(bRow).toBeVisible({ timeout: 30_000 });
    const navStartTime = await page.evaluate(() => performance.now());
    await aRow.click({ timeout: 10_000 });
    await bRow.click({ timeout: 10_000 });

    await page.waitForFunction(
      (target: string) =>
        Boolean(window.__activeProvider?.isSynced) &&
        window.__activeProvider?.configuration?.name === target,
      docB,
      { timeout: 30_000 },
    );
    await expect(page.locator('.ProseMirror', { hasText: `Unique-B-marker-${docB}` })).toBeVisible({
      timeout: 30_000,
    });

    const totalPmCount = await page.locator('.ProseMirror').count();
    expect(totalPmCount).toBeLessThanOrEqual(3);
    expect(totalPmCount).toBeGreaterThanOrEqual(1);

    await page.waitForFunction(
      ({ targetDoc, since }) => {
        const isMountSettle = (entry: PerformanceEntry) =>
          entry.name === 'ok/mount/resolve' ||
          entry.name === 'ok/mount/reject' ||
          entry.name === 'ok/cache/hit';
        return performance
          .getEntriesByType('measure')
          .filter(isMountSettle)
          .filter((m) => m.startTime >= since)
          .some((m) => {
            const detail = (m as unknown as { detail?: { devtools?: { properties?: unknown } } })
              .detail;
            const props = (detail?.devtools?.properties ?? []) as Array<[string, string]>;
            return props.find(([k]) => k === 'docName')?.[1] === targetDoc;
          });
      },
      { targetDoc: docA, since: navStartTime },
      { timeout: 30_000 },
    );
    const aSettleMarks = await page.evaluate(
      ({ targetDoc, since }) => {
        const isMountSettle = (entry: PerformanceEntry) =>
          entry.name === 'ok/mount/resolve' ||
          entry.name === 'ok/mount/reject' ||
          entry.name === 'ok/cache/hit';
        return performance
          .getEntriesByType('measure')
          .filter(isMountSettle)
          .filter((m) => m.startTime >= since)
          .map((m) => {
            const detail = (m as unknown as { detail?: { devtools?: { properties?: unknown } } })
              .detail;
            const props = (detail?.devtools?.properties ?? []) as Array<[string, string]>;
            const docName = props.find(([k]) => k === 'docName')?.[1];
            const reason = props.find(([k]) => k === 'reason')?.[1];
            return { name: m.name, docName, reason };
          })
          .filter((m) => m.docName === targetDoc);
      },
      { targetDoc: docA, since: navStartTime },
    );
    expect(aSettleMarks.length).toBeGreaterThanOrEqual(1);
    const validReasons = new Set([undefined, 'aborted']);
    for (const m of aSettleMarks) {
      const isValid =
        m.name === 'ok/mount/resolve' ||
        m.name === 'ok/cache/hit' ||
        (m.name === 'ok/mount/reject' && validReasons.has(m.reason));
      expect(isValid, `unexpected mount-promise settle for ${docA}: ${JSON.stringify(m)}`).toBe(
        true,
      );
    }

    const errors = logs.filter((l) => l.type === 'error' || l.type === 'uncaught');
    const criticalErrors = filterCriticalErrors(errors);
    if (criticalErrors.length > 0) {
      console.error('[NG7 rapid-nav] critical errors:', JSON.stringify(criticalErrors, null, 2));
    }
    expect(criticalErrors).toEqual([]);
  });
});
