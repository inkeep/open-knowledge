import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { walkFiles } from './fs-walk.ts';
import { makeTree, read } from './mktree.test-helper.ts';
import { applyPlan, buildPlan } from './plan.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const ID = '2a145f35b5ad808e9200ff850d964d8f';
const HOME = '2fb45f35b5ad81ea89410042576b8439';
const R1 = '11111111111111111111111111111111';
const R2 = '22222222222222222222222222222222';

function notionExport(): string {
  return makeTree({
    [`Home ${HOME}.md`]: [
      '# Home',
      '',
      `See [Content Plan](Content%20Plan%20${ID}.md).`,
      '',
      `[](data:image/png;base64,${PNG})`,
      '',
      '<aside>',
      '👋 Welcome!',
      '</aside>',
      '',
    ].join('\n'),
    // Database stub + CSV + title-only row folder.
    [`Content Plan ${ID}.md`]: `# Content Plan\n\n[Content Plan](Content%20Plan%20${ID}_all.csv)\n`,
    [`Content Plan ${ID}_all.csv`]:
      'Headline,Status,Note\n"Alpha (v1)",Done,"line1\nline2"\n"Beta",Todo,"a | b"\n',
    [`Content Plan/Alpha v1 ${R1}.md`]: [
      '# Alpha (v1)',
      '',
      'Status: Done',
      'Note: line1',
      '',
      '## Body',
      '',
      'Has a real body.',
      '',
    ].join('\n'),
    [`Content Plan/Beta ${R2}.md`]: '# Beta\n\nStatus: Todo\n',
  });
}

function snapshot(root: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  for (const f of walkFiles(root)) snap.set(f.slice(root.length), readFileSync(f));
  return snap;
}

describe('buildPlan / applyPlan', () => {
  test('dry-run reports changes but writes nothing', () => {
    const root = notionExport();
    const before = snapshot(root);
    const { report, changes } = buildPlan(root);
    expect(report.isNotionExport).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
    // Disk is untouched by a dry-run.
    const after = snapshot(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(after.get(k)?.equals(v)).toBe(true);
  });

  test('apply performs all five transforms', () => {
    const root = notionExport();
    applyPlan(buildPlan(root));

    const home = read(root, `/Home ${HOME}.md`);
    expect(home).toContain(`[Content Plan](<Content Plan ${ID}.md>)`); // link decoded + angle-wrapped
    expect(home).toContain('> [!note]'); // callout
    expect(home).toContain('> Welcome!');
    expect(home).toMatch(/!\[]\(home-[a-z0-9-]+-inline-1\.png\)/); // image embed
    expect(home).not.toContain('data:image');

    // The image transform wrote the asset file.
    const assets = walkFiles(root).filter((f) => f.endsWith('.png'));
    expect(assets).toHaveLength(1);

    // Table in the stub, row pages kept.
    const stub = read(root, `/Content Plan ${ID}.md`);
    expect(stub).toContain('| Headline | Status | Note |');
    expect(stub).toContain('line1<br>line2'); // embedded newline flattened
    expect(stub).toContain('a \\| b'); // pipe escaped
    expect(stub).toContain(`[Alpha (v1)](<Content Plan/Alpha v1 ${R1}.md>)`); // title link, punct-matched
    expect(walkFiles(root).some((f) => f.endsWith(`Alpha v1 ${R1}.md`))).toBe(true); // row page kept

    // Frontmatter on a row page.
    const alpha = read(root, `/Content Plan/Alpha v1 ${R1}.md`);
    expect(alpha.startsWith('---\n')).toBe(true);
    expect(alpha).toContain('Status: Done');
    expect(alpha).toContain('## Body'); // body preserved
  });

  test('is idempotent — a second apply changes nothing', () => {
    const root = notionExport();
    applyPlan(buildPlan(root));
    const afterFirst = snapshot(root);

    const secondPlan = buildPlan(root);
    expect(secondPlan.changes).toHaveLength(0);
    expect(secondPlan.assets).toHaveLength(0);
    applyPlan(secondPlan);

    const afterSecond = snapshot(root);
    expect([...afterSecond.keys()].sort()).toEqual([...afterFirst.keys()].sort());
    for (const [k, v] of afterFirst) expect(afterSecond.get(k)?.equals(v)).toBe(true);
  });

  test('refuses a non-Notion directory (no changes, flagged)', () => {
    const root = makeTree({ 'notes.md': '# Notes\n\nPlain.\n', 'more.md': '# More\n' });
    const { report, changes } = buildPlan(root);
    expect(report.isNotionExport).toBe(false);
    expect(changes).toHaveLength(0);
  });

  test('--force processes even when detection is negative', () => {
    const root = makeTree({ 'page.md': '# P\n\n[x](Foo%20Bar.md)\n' });
    const { changes } = buildPlan(root, { force: true });
    expect(changes.some((c) => c.content.includes('[x](<Foo Bar.md>)'))).toBe(true);
  });

  test('--only limits the transforms run', () => {
    const root = notionExport();
    const { report } = buildPlan(root, { selected: new Set(['links']) });
    expect(report.transforms.links).toBeGreaterThan(0);
    expect(report.transforms.callouts).toBe(0);
    expect(report.transforms.tables).toBe(0);
  });

  test('creates a table page for a database CSV that has no stub (orphan)', () => {
    const root = makeTree({
      [`Home ${HOME}.md`]: '# Home\n',
      [`Customers ${ID}_all.csv`]: 'Name,Type\nAcme,Paid\n',
      [`Customers/Acme ${R1}.md`]: '# Acme\n\nType: Paid\n',
    });
    const { changes, report } = buildPlan(root);
    expect(report.stubsCreated).toBe(1);
    const stub = changes.find((c) => c.path.endsWith(`Customers ${ID}.md`));
    expect(stub).toBeDefined();
    expect(stub?.content.startsWith('# Customers')).toBe(true);
    expect(stub?.content).toContain('| Name | Type |');
    expect(stub?.content).toContain(`[Acme](<Customers/Acme ${R1}.md>)`);
  });

  test('--remove-csv schedules the CSV for deletion', () => {
    const root = notionExport();
    const { deletions, report } = buildPlan(root, { removeCsv: true });
    expect(deletions.some((p) => p.endsWith('_all.csv'))).toBe(true);
    expect(report.csvsRemoved).toBeGreaterThan(0);
  });

  test('--remove-csv deletes the CSV, keeps the table + row pages, stays idempotent', () => {
    const root = notionExport();
    applyPlan(buildPlan(root, { removeCsv: true }));
    expect(walkFiles(root).some((f) => f.endsWith('_all.csv'))).toBe(false); // CSV gone
    expect(read(root, `/Content Plan ${ID}.md`)).toContain('| Headline | Status | Note |'); // table kept
    expect(walkFiles(root).some((f) => f.endsWith(`Alpha v1 ${R1}.md`))).toBe(true); // row pages kept

    const second = buildPlan(root, { removeCsv: true });
    expect(second.changes).toHaveLength(0);
    expect(second.deletions).toHaveLength(0);
  });

  test('redirects a cross-page link to a database CSV onto the table page (no dangle after --remove-csv)', () => {
    const root = makeTree({
      // A page that links to another database's CSV (as real Notion exports do).
      [`Hub ${HOME}.md`]: `# Hub\n\nSee [Customers](Customers%20${ID}_all.csv).\n`,
      [`Customers ${ID}_all.csv`]: 'Name,Type\nAcme,Paid\n',
      [`Customers/Acme ${R1}.md`]: '# Acme\n\nType: Paid\n',
    });
    applyPlan(buildPlan(root, { removeCsv: true }));
    const hub = read(root, `/Hub ${HOME}.md`);
    // Link now points at the generated table page, not the deleted CSV.
    expect(hub).toContain(`[Customers](<Customers ${ID}.md>)`);
    expect(hub).not.toContain('_all.csv');
    expect(walkFiles(root).some((f) => f.endsWith(`Customers ${ID}.md`))).toBe(true);
  });

  test('reports wide tables and ambiguous title links', () => {
    const wideHeader = Array.from({ length: 20 }, (_, i) => `col${i}`).join(',');
    const root = makeTree({
      [`Home ${HOME}.md`]: '# Home\n',
      [`Big ${ID}_all.csv`]: `${wideHeader}\n`,
      // Duplicate row titles → ambiguous title-column links.
      [`Dupes ${R1}_all.csv`]: 'Title,X\nNotes,1\nNotes,2\n',
      [`Dupes/Notes ${R1}.md`]: '# Notes\n',
      [`Dupes/Notes ${R2}.md`]: '# Notes\n',
    });
    const { report } = buildPlan(root);
    expect(report.wideTables.length).toBeGreaterThan(0);
    expect(report.ambiguousTitleLinks).toBeGreaterThan(0);
  });
});
