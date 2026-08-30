import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveProjectTemplates, resolveTemplatesAvailable } from './templates-resolver.ts';

describe('resolveTemplatesAvailable', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'tpl-resolver-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function writeTemplate(folder: string, name: string, body: string): void {
    const dir = join(projectDir, folder, '.ok', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body);
  }

  function withFm(title: string, description: string, body = ''): string {
    return `---\ntitle: ${title}\ndescription: ${description}\n---\n${body}`;
  }

  test('returns empty when no .ok/templates/ exists anywhere', () => {
    expect(resolveTemplatesAvailable(projectDir, 'meetings')).toEqual([]);
    expect(resolveTemplatesAvailable(projectDir, '')).toEqual([]);
  });

  test('local templates: scope local at the target folder', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Meeting Prep', 'Use before a meeting.'));
    writeTemplate('meetings', 'post-notes', withFm('Meeting Post', 'Use after a meeting.'));

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(2);
    const names = tpls.map((t) => t.name).sort();
    expect(names).toEqual(['post-notes', 'prep-notes']);
    for (const t of tpls) {
      expect(t.scope).toBe('local');
      expect(t.source_folder).toBe('meetings');
    }
    const prep = tpls.find((t) => t.name === 'prep-notes');
    expect(prep?.title).toBe('Meeting Prep');
    expect(prep?.description).toBe('Use before a meeting.');
    expect(prep?.path).toBe('meetings/.ok/templates/prep-notes.md');
  });

  test('inherited templates: ancestor templates surface as scope inherited', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Meeting Prep', 'Top-level prep.'));
    // No local templates at meetings/prep-notes/
    mkdirSync(join(projectDir, 'meetings', 'prep-notes'), { recursive: true });

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]).toEqual({
      name: 'prep-notes',
      title: 'Meeting Prep',
      description: 'Top-level prep.',
      path: 'meetings/.ok/templates/prep-notes.md',
      source_folder: 'meetings',
      scope: 'inherited',
    });
  });

  test('closest wins on filename collision in the inheritance chain (D7)', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Generic Prep', 'From meetings/.'));
    writeTemplate(
      'meetings/prep-notes',
      'prep-notes',
      withFm('Specific Prep', 'From prep-notes/.'),
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBe('Specific Prep');
    expect(tpls[0]?.scope).toBe('local');
    expect(tpls[0]?.source_folder).toBe('meetings/prep-notes');
  });

  test('siblings are NOT visible (scope rule)', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Prep', 'For meetings.'));
    writeTemplate('research', 'research-log', withFm('Research', 'For research.'));

    const tpls = resolveTemplatesAvailable(projectDir, 'research');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('research-log');
    // meetings/prep-notes must NOT appear here
    expect(tpls.find((t) => t.name === 'prep-notes')).toBeUndefined();
  });

  test('descendant templates do NOT surface in the parent folder (D17 — two-value scope)', () => {
    // Template lives at meetings/prep-notes/.ok/templates/agenda.md
    writeTemplate(
      'meetings/prep-notes',
      'agenda',
      withFm('Detailed Agenda', 'For larger meetings.'),
    );

    // From parent `meetings/`, agenda is NOT visible — it lives in a subfolder.
    expect(resolveTemplatesAvailable(projectDir, 'meetings')).toEqual([]);

    // depth>1 is reserved for forward-compat; currently a no-op (descendants
    // are surfaced by list_documents via subfolders[] enrichment, not this
    // resolver).
    expect(resolveTemplatesAvailable(projectDir, 'meetings', { depth: 2 })).toEqual([]);
    expect(resolveTemplatesAvailable(projectDir, 'meetings', { depth: Infinity })).toEqual([]);

    // From the OWN folder, the template is local.
    const ownTpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(ownTpls).toHaveLength(1);
    expect(ownTpls[0]?.name).toBe('agenda');
    expect(ownTpls[0]?.scope).toBe('local');
    expect(ownTpls[0]?.source_folder).toBe('meetings/prep-notes');
  });

  test('depth parameter is a no-op — no descent into subfolders from the resolver', () => {
    writeTemplate('a/b/c', 'deep', withFm('Deep', 'Buried in a/b/c.'));

    // From `a/`: deep doesn't surface, regardless of depth.
    expect(resolveTemplatesAvailable(projectDir, 'a')).toEqual([]);
    expect(resolveTemplatesAvailable(projectDir, 'a', { depth: 2 })).toEqual([]);
    expect(resolveTemplatesAvailable(projectDir, 'a', { depth: 100 })).toEqual([]);
    expect(resolveTemplatesAvailable(projectDir, 'a', { depth: Infinity })).toEqual([]);

    // From `a/b/c/`: visible as local.
    const own = resolveTemplatesAvailable(projectDir, 'a/b/c');
    expect(own).toHaveLength(1);
    expect(own[0]?.name).toBe('deep');
    expect(own[0]?.scope).toBe('local');
  });

  test('templates without description still surface; title is required at write time but readable here without it (resolver tolerates legacy)', () => {
    // No frontmatter at all
    writeTemplate('meetings', 'no-meta', '# Just a body\n');

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('no-meta');
    expect(tpls[0]?.title).toBeUndefined();
    expect(tpls[0]?.description).toBeUndefined();
    expect(tpls[0]?.scope).toBe('local');
  });

  test('frontmatter whose opening fence carries a trailing space still surfaces metadata', () => {
    // `--- ` is one in-tolerance keystroke away from `---`; recognition must
    // agree with core's FRONTMATTER_RE so the templates listing and
    // GET /api/template see the same metadata.
    writeTemplate(
      'meetings',
      'prep-notes',
      '--- \ntitle: Meeting Prep\ndescription: Use before a meeting.\n---\nbody\n',
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBe('Meeting Prep');
    expect(tpls[0]?.description).toBe('Use before a meeting.');
  });

  test('frontmatter whose closing fence carries a trailing tab still surfaces metadata', () => {
    writeTemplate(
      'meetings',
      'prep-notes',
      '---\ntitle: Meeting Prep\ndescription: Use before a meeting.\n---\t\nbody\n',
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBe('Meeting Prep');
    expect(tpls[0]?.description).toBe('Use before a meeting.');
  });

  test('an indented opening fence is not frontmatter (matches core recognition)', () => {
    writeTemplate('meetings', 'prep-notes', ' ---\ntitle: Nope\n---\nbody\n');

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBeUndefined();
    expect(tpls[0]?.description).toBeUndefined();
  });

  test('non-md files in templates/ are ignored', () => {
    writeTemplate('meetings', 'good', withFm('Good', 'OK'));
    const dir = join(projectDir, 'meetings', '.ok', 'templates');
    writeFileSync(join(dir, 'README.txt'), 'not a template');
    writeFileSync(join(dir, 'image.png'), 'fake png');

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('good');
  });

  test('project-root templates are inherited everywhere', () => {
    writeTemplate('', 'global', withFm('Global Template', 'Available everywhere.'));

    // From a deep nested folder, inherit it
    mkdirSync(join(projectDir, 'meetings', 'prep-notes'), { recursive: true });
    const tpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('global');
    expect(tpls[0]?.scope).toBe('inherited');
    expect(tpls[0]?.source_folder).toBe('');
  });

  test('malformed frontmatter is treated as no metadata, not an error', () => {
    const dir = join(projectDir, 'broken', '.ok', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.md'), '---\ntitle: [no closing\nbroken yaml\n---\nbody\n');

    const tpls = resolveTemplatesAvailable(projectDir, 'broken');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('broken');
    expect(tpls[0]?.title).toBeUndefined();
    expect(tpls[0]?.description).toBeUndefined();
  });

  test('a template symlinked outside the project root is dropped from the menu', async () => {
    // `statSync` follows the link, so an escaping template would otherwise
    // surface as a menu entry every consumer trusts to read. Containment is
    // enforced here in the resolver, so it never appears. A sibling legitimate
    // template in the same folder still resolves.
    const outside = await mkdtemp(join(tmpdir(), 'tpl-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
      writeTemplate('notes', 'ok', withFm('OK', 'In-root template.'));
      const tplDir = join(projectDir, 'notes', '.ok', 'templates');
      symlinkSync(join(outside, 'secret.txt'), join(tplDir, 'leak.md'), 'file');

      const tpls = resolveTemplatesAvailable(projectDir, 'notes');
      expect(tpls.map((t) => t.name).sort()).toEqual(['ok']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a template symlinked to an in-root but out-of-templates path is dropped', () => {
    // The containment anchor is the enumerating `.ok/templates/` directory, not
    // the project root. A link pointing INSIDE the root but at `.ok/local/`
    // (agent scratch, out of content scope) would still exfiltrate that file's
    // bytes into a newly created doc, so it must drop too — a project-root anchor
    // would have kept it.
    const okLocal = join(projectDir, '.ok', 'local');
    mkdirSync(okLocal, { recursive: true });
    writeFileSync(join(okLocal, 'last-spawn-error.log'), 'stack trace with secrets');
    writeTemplate('notes', 'ok', withFm('OK', 'In-root template.'));
    symlinkSync(
      join(okLocal, 'last-spawn-error.log'),
      join(projectDir, 'notes', '.ok', 'templates', 'leak.md'),
      'file',
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'notes');
    expect(tpls.map((t) => t.name).sort()).toEqual(['ok']);
  });

  test('a templates DIRECTORY symlinked out of the project drops all its entries', async () => {
    // A symlinked `.ok/templates` is refused wholesale by the `lstat` gate
    // (and, as backstop, `assertNoSymlinkEscape` realpaths its ANCHOR, so a
    // `templatesDir`-only anchor would relocate to the link target — the
    // project-root anchor refuses the out-of-project shape even without the
    // gate). This pins the out-of-project direction.
    const outside = await mkdtemp(join(tmpdir(), 'tpl-dir-outside-'));
    try {
      writeFileSync(join(outside, 'leak.md'), withFm('Leak', 'Foreign template.'));
      mkdirSync(join(projectDir, 'notes', '.ok'), { recursive: true });
      symlinkSync(outside, join(projectDir, 'notes', '.ok', 'templates'), 'dir');

      expect(resolveTemplatesAvailable(projectDir, 'notes')).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a templates DIRECTORY symlinked elsewhere IN-project is skipped wholesale', async () => {
    // The per-entry anchors cannot catch this shape: anchor 1 realpaths to the
    // link target and every entry is trivially inside it; anchor 2 passes
    // because the target is inside the project. Only the `lstat` gate — which
    // does not follow the link — refuses it, keeping in-project `.md` files
    // (e.g. `.okignore`-excluded ones) from surfacing as menu items.
    writeFileSync(join(projectDir, 'stash.md'), withFm('Stash', 'Not a template.'));
    mkdirSync(join(projectDir, 'notes', '.ok'), { recursive: true });
    symlinkSync(projectDir, join(projectDir, 'notes', '.ok', 'templates'), 'dir');

    expect(resolveTemplatesAvailable(projectDir, 'notes')).toEqual([]);
  });
});

describe('resolveProjectTemplates', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'tpl-project-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function writeTemplate(folder: string, name: string, body: string): void {
    const dir = folder
      ? join(projectDir, folder, '.ok', 'templates')
      : join(projectDir, '.ok', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body);
  }

  function withFm(title: string, description: string): string {
    return `---\ntitle: ${title}\ndescription: ${description}\n---\nbody\n`;
  }

  test('returns flat list of every template across the project', async () => {
    writeTemplate('', 'daily-note', withFm('Daily note', 'Date-stamped log for today'));
    writeTemplate('meetings', 'meeting-notes', withFm('Meeting notes', 'Attendees, agenda, items'));
    writeTemplate('research', 'research-log', withFm('Research log', 'Working notes'));
    writeTemplate('specs', 'spec', withFm('Spec / RFC', 'Problem · proposal · decision'));

    const result = await resolveProjectTemplates(projectDir);
    const byName = Object.fromEntries(result.templates.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      'daily-note',
      'meeting-notes',
      'research-log',
      'spec',
    ]);
    expect(byName['daily-note']?.source_folder).toBe('');
    expect(byName['meeting-notes']?.source_folder).toBe('meetings');
    expect(byName['research-log']?.source_folder).toBe('research');
    expect(byName.spec?.source_folder).toBe('specs');
    expect(result.truncated).toBe(false);
  });

  test('templates in nested subfolders surface with their source_folder', async () => {
    writeTemplate('a/b/c', 'deep', withFm('Deep template', 'Buried in a/b/c'));
    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.source_folder).toBe('a/b/c');
    expect(result.templates[0]?.path).toBe('a/b/c/.ok/templates/deep.md');
  });

  test('skips node_modules, dist, build, and dot-prefixed dirs', async () => {
    writeTemplate('keep', 'visible', withFm('Visible', 'Should appear'));
    writeTemplate('node_modules/dep', 'hidden', withFm('Hidden', 'Should NOT appear'));
    writeTemplate('dist/output', 'hidden', withFm('Hidden', 'Should NOT appear'));
    writeTemplate('build/out', 'hidden', withFm('Hidden', 'Should NOT appear'));
    writeTemplate('.archive', 'hidden', withFm('Hidden', 'Dot-prefix excluded'));

    const result = await resolveProjectTemplates(projectDir);
    const folders = result.templates.map((t) => t.source_folder).sort();
    expect(folders).toEqual(['keep']);
  });

  test('walker terminates within PROJECT_TEMPLATE_SCAN_CAP — guards against pathological trees', async () => {
    // Build a wide tree exceeding the 2000-dir cap to verify the walker
    // bails out cleanly rather than hanging or stack-overflowing AND
    // collects templates queued before the cap. The `aa-` prefix makes
    // the early folder sort alphabetically before `bulk-*` (so it's
    // queued first on hash-bucket-order filesystems like Linux ext4 as
    // well as creation-order filesystems like APFS).
    writeTemplate('', 'visible-root', withFm('Root', 'At root'));
    writeTemplate('aa-early', 'visible-early', withFm('Early', 'Early in BFS'));
    // 2100 sibling dirs at root — exceeds the cap by ~5%.
    for (let i = 0; i < 2100; i++) {
      mkdirSync(join(projectDir, `bulk-${i}`), { recursive: true });
    }
    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates.some((t) => t.name === 'visible-root')).toBe(true);
    expect(result.templates.some((t) => t.name === 'visible-early')).toBe(true);
    // Cap was exceeded — flag must be set so the UI / response can signal it.
    expect(result.truncated).toBe(true);
  });

  test('returns empty array when no templates exist anywhere', async () => {
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    await expect(resolveProjectTemplates(projectDir)).resolves.toEqual({
      templates: [],
      truncated: false,
    });
  });

  test('every entry carries scope: local (no inheritance context in flat enumeration)', async () => {
    writeTemplate('', 'root-tpl', withFm('Root', 'At project root'));
    writeTemplate('subfolder', 'sub-tpl', withFm('Sub', 'In a subfolder'));
    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates).toHaveLength(2);
    for (const t of result.templates) {
      expect(t.scope).toBe('local');
    }
  });

  test('descends through a symlinked directory', async () => {
    // A Dirent reports the link's own type, so the walker needs an explicit
    // following stat for symlinks or symlinked folders silently stop being
    // enumerated.
    writeTemplate('real', 'linked-tpl', withFm('Linked', 'Behind a symlink'));
    symlinkSync(join(projectDir, 'real'), join(projectDir, 'alias'), 'dir');

    const result = await resolveProjectTemplates(projectDir);
    const folders = result.templates.map((t) => t.source_folder).sort();
    expect(folders).toEqual(['alias', 'real']);
    // `path` is how a caller reaches the file, and it stays relative to the
    // link rather than resolving through it — both spellings are valid on disk.
    expect(result.templates.map((t) => t.path).sort()).toEqual([
      'alias/.ok/templates/linked-tpl.md',
      'real/.ok/templates/linked-tpl.md',
    ]);
  });

  test('a dangling symlink is skipped without aborting the walk', async () => {
    // The following stat throws ENOENT on a broken link. Swallowing it is what
    // keeps one stale link from cutting the scan short and hiding every
    // template the walker had not reached yet.
    writeTemplate('real', 'survivor', withFm('Survivor', 'Must still surface'));
    symlinkSync(join(projectDir, 'no-such-target'), join(projectDir, 'dangling'), 'dir');

    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates.map((t) => t.source_folder)).toEqual(['real']);
    expect(result.truncated).toBe(false);
  });

  test('every call re-walks, so a template written between scans surfaces', async () => {
    // Templates reach disk through the filesystem writers, the CRDT
    // managed-artifact path, and plain external edits. Nothing here may
    // serve a snapshot that predates the caller: a memo would have to be
    // invalidated from all three, and a missed one hides a template the
    // user just created.
    writeTemplate('', 'first', withFm('First', 'Present at first scan'));
    const before = await resolveProjectTemplates(projectDir);
    expect(before.templates.map((t) => t.name)).toEqual(['first']);

    writeTemplate('', 'second', withFm('Second', 'Added after the first scan'));
    const after = await resolveProjectTemplates(projectDir);
    expect(after.templates.map((t) => t.name).sort()).toEqual(['first', 'second']);
  });

  test('yields to the event loop while walking', async () => {
    // The reason this resolver is async at all: the walk must not hold the
    // loop that services CRDT sync, or users feel it as keystroke lag. The
    // other tests here all still pass against a synchronous walk wrapped in
    // an async function, because awaiting a non-promise is a no-op — so
    // without this one, a refactor back to sync I/O lands green.
    //
    // A check-phase callback is the discriminator. A synchronous walk leaves
    // the promise already settled, so the await continuation runs as a
    // microtask, and microtasks drain before the loop ever reaches its check
    // phase. Real async I/O suspends at the first readdir, so the loop turns
    // and the callback runs.
    //
    // `setImmediate`, not `setTimeout(…, 0)`: a 0 ms timeout is clamped to
    // 1 ms, and a walk this small can finish inside that window — the loop
    // turned, but no timer was due to witness it. That reads as a failure.
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(projectDir, `dir-${i}`), { recursive: true });
    }
    let ticked = false;
    const pending = setImmediate(() => {
      ticked = true;
    });

    await resolveProjectTemplates(projectDir);
    clearImmediate(pending);

    expect(ticked).toBe(true);
  });

  test('a deleted template stops surfacing on the next call', async () => {
    writeTemplate('', 'doomed', withFm('Doomed', 'About to be removed'));
    const before = await resolveProjectTemplates(projectDir);
    expect(before.templates.map((t) => t.name)).toEqual(['doomed']);

    rmSync(join(projectDir, '.ok', 'templates', 'doomed.md'));
    const after = await resolveProjectTemplates(projectDir);
    expect(after.templates).toEqual([]);
  });
});
