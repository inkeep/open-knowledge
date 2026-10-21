import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_DOC_NAMES } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { _resetDocExtensionsForTests, registerDocExtension } from './doc-extensions.ts';
import {
  DocNoticeLedger,
  docNoticesPath,
  NOTICE_WITHDRAW_AFTER_MS,
  type NoticeFile,
} from './doc-notices.ts';
import { createMergeHistoryRecorder } from './merge-history.ts';
import {
  DEFAULT_CHECKPOINT_RETENTION,
  gcCheckpointRefs,
  initShadowRepo,
  type ShadowHandle,
} from './shadow-repo.ts';

const KEPT_ONE = { duplicated: 1, restoredDeletedHere: 0, restoredDeletedOutside: 0 };

describe('DocNoticeLedger', () => {
  let projectDir: string;
  let signal: ReturnType<typeof vi.fn<() => void>>;

  let clock = 0;
  let held = new Set<string>();

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-doc-notices-')));
    signal = vi.fn<() => void>();
    clock = 0;
    held = new Set();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    _resetDocExtensionsForTests();
  });

  function seedDoc(docName: string, extension = '.md'): void {
    const file = join(projectDir, `${docName}${extension}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Doc\n');
  }

  function ledger(
    options: {
      shadow?: ShadowHandle;
      ready?: boolean;
      resolveFile?: (docName: string) => NoticeFile | null;
      isSaveHeld?: (docName: string) => boolean;
    } = {},
  ): DocNoticeLedger {
    return new DocNoticeLedger({
      projectDir,
      contentDir: projectDir,
      getShadow: () => options.shadow,
      isReady: () => options.ready ?? true,
      signal,
      isHeld: (docName) => held.has(docName),
      now: () => clock,
      resolveFile: options.resolveFile,
      isSaveHeld: options.isSaveHeld,
    });
  }

  test('a both-kept merge raises one notice for that document, on its own branch only', async () => {
    seedDoc('notes');
    const notices = ledger();

    const id = notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });

    expect(await notices.list('main')).toEqual([
      expect.objectContaining({
        id,
        docName: 'notes',
        file: 'notes.md',
        kind: 'both-kept',
        kept: KEPT_ONE,
        events: 1,
      }),
    ]);
    expect(await notices.list('feature')).toEqual([]);
  });

  test('a second event on the same document updates its notice instead of stacking another', async () => {
    seedDoc('notes');
    const notices = ledger();

    const first = notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    const second = notices.record('notes', 'main', {
      kind: 'moved-to-history',
      side: 'theirs',
      reason: 'check-failed',
      entry: 'a'.repeat(40),
    });

    expect(second).toBe(first);
    const listed = await notices.list('main');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: first,
      kind: 'moved-to-history',
      side: 'theirs',
      events: 2,
      entries: ['a'.repeat(40)],
    });
  });

  test('a notice survives a restart, dismissal removes it for good, and a later merge raises a fresh one', async () => {
    seedDoc('notes');
    const id = ledger().record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    expect(id).not.toBeNull();

    const reopened = ledger();
    expect((await reopened.list('main')).map((notice) => notice.id)).toEqual([id]);

    expect(reopened.dismiss('notes', id ?? '')).toBe(true);
    expect(reopened.dismiss('notes', id ?? '')).toBe(false);
    expect(await ledger().list('main')).toEqual([]);

    const fresh = ledger().record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    expect(fresh).not.toBe(id);
  });

  test('backup and held-save notices survive a restart, and withdrawing a held save leaves any other notice alone', async () => {
    seedDoc('flow', '.mmd');
    seedDoc('notes');
    const backup = '~/.ok/edit-backups/discarded/flow.mmd/2026-10-21T10-00-00-000Z.mmd';
    ledger().record('flow.mmd', 'main', {
      kind: 'moved-to-backup',
      side: 'theirs',
      reason: 'no-merge-engine',
      backup,
    });
    ledger().record('notes', 'main', { kind: 'save-held', cause: 'keeps-changing' });

    const reopened = ledger();
    expect(await reopened.list('main')).toEqual([
      expect.objectContaining({ docName: 'notes', kind: 'save-held', cause: 'keeps-changing' }),
      expect.objectContaining({
        docName: 'flow.mmd',
        file: 'flow.mmd',
        kind: 'moved-to-backup',
        side: 'theirs',
        reason: 'no-merge-engine',
        backup,
        entries: [],
      }),
    ]);

    reopened.withdrawHeld('flow.mmd', 'main');
    reopened.withdrawHeld('notes', 'main');
    expect((await ledger().list('main')).map((notice) => notice.docName)).toEqual(['flow.mmd']);
  });

  test('a held save and a kept version on one document show side by side, and clearing the hold keeps the kept-version notice', async () => {
    seedDoc('notes');
    const kept = ledger().record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    const held = ledger().record('notes', 'main', { kind: 'save-held', cause: 'unreadable' });
    ledger().record('notes', 'main', {
      kind: 'moved-to-history',
      side: 'theirs',
      reason: 'check-failed',
      entry: 'a'.repeat(40),
    });

    const shown = await ledger().list('main');
    expect(shown.map((notice) => notice.kind).sort()).toEqual(['moved-to-history', 'save-held']);
    expect(shown.find((notice) => notice.kind === 'save-held')?.id).toBe(held);
    expect(shown.find((notice) => notice.kind === 'moved-to-history')?.id).toBe(kept);

    const reopened = ledger();
    reopened.rename('notes', 'renamed', 'main');
    reopened.withdrawHeld('renamed', 'main');

    expect(await ledger().list('main')).toEqual([
      expect.objectContaining({
        docName: 'renamed',
        kind: 'moved-to-history',
        entries: ['a'.repeat(40)],
      }),
    ]);
  });

  test('a held-save notice whose hold is gone, as after a restart, is withdrawn at the next read and the kept-version notice stays', async () => {
    seedDoc('notes');
    ledger().record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    ledger().record('notes', 'main', { kind: 'save-held', cause: 'keeps-changing' });

    expect(
      (await ledger({ isSaveHeld: () => true }).list('main')).map((notice) => notice.kind).sort(),
    ).toEqual(['both-kept', 'save-held']);
    expect(
      (await ledger({ ready: false, isSaveHeld: () => false }).list('main')).map(
        (notice) => notice.kind,
      ),
    ).toContain('save-held');

    const afterRestart = ledger({ isSaveHeld: () => false });
    expect((await afterRestart.list('main')).map((notice) => notice.kind)).toEqual(['both-kept']);
    expect((await ledger().list('main')).map((notice) => notice.kind)).toEqual(['both-kept']);
  });

  test('a dismissed held-save notice comes back when the hold is raised again, and a hold raised again while shown changes nothing', async () => {
    seedDoc('notes');
    const notices = ledger({ isSaveHeld: () => true });
    const first = notices.record('notes', 'main', { kind: 'save-held', cause: 'unreadable' });
    signal.mockClear();

    expect(notices.record('notes', 'main', { kind: 'save-held', cause: 'unreadable' })).toBe(first);
    expect(signal).not.toHaveBeenCalled();
    expect(await notices.list('main')).toEqual([
      expect.objectContaining({ id: first, kind: 'save-held', events: 1 }),
    ]);

    expect(notices.dismiss('notes', first ?? '')).toBe(true);
    expect(await notices.list('main')).toEqual([]);

    const again = notices.record('notes', 'main', { kind: 'save-held', cause: 'unreadable' });
    expect(again).not.toBe(first);
    expect(await notices.list('main')).toEqual([
      expect.objectContaining({ id: again, kind: 'save-held', cause: 'unreadable' }),
    ]);
  });

  test('a notice file from another version, or one it cannot parse, is dropped and the project still opens', async () => {
    seedDoc('notes');
    ledger().record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    const path = docNoticesPath(projectDir);
    const valid = JSON.parse(readFileSync(path, 'utf-8')) as { version: number };
    expect((await ledger().list('main')).map((notice) => notice.docName)).toEqual(['notes']);

    for (const unreadable of ['{not json', JSON.stringify({ ...valid, version: 99 })]) {
      writeFileSync(path, unreadable);
      const notices = ledger();
      expect(await notices.list('main')).toEqual([]);
      notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ version: 1 });
    }
  });

  test('the system document never gets a notice', async () => {
    const notices = ledger();

    expect(notices.record('__system__', 'main', { kind: 'both-kept', kept: KEPT_ONE })).toBeNull();
    expect(signal).not.toHaveBeenCalled();
  });

  test('a settings file gets a notice named after its file, and dismissing it removes it', async () => {
    const outside = join(projectDir, 'outside');
    const files = new Map<string, NoticeFile>();
    for (const configDoc of CONFIG_DOC_NAMES) {
      const abs = join(outside, configDoc.replace(/\//g, '-'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, 'a: 1\n');
      files.set(configDoc, { abs, display: `.ok/${configDoc.replace(/\//g, '-')}` });
    }
    const notices = ledger({ resolveFile: (docName) => files.get(docName) ?? null });
    const ids = CONFIG_DOC_NAMES.map((configDoc) =>
      notices.record(configDoc, 'main', {
        kind: 'moved-to-history',
        side: 'ours',
        reason: 'outside-settings-applied',
        entry: 'e'.repeat(40),
      }),
    );

    clock += NOTICE_WITHDRAW_AFTER_MS * 2;
    const listed = await notices.list('main');
    expect(listed.map((notice) => [notice.docName, notice.file]).sort()).toEqual(
      CONFIG_DOC_NAMES.map((configDoc) => [configDoc, files.get(configDoc)?.display]).sort(),
    );
    expect(notices.dismiss(CONFIG_DOC_NAMES[0], ids[0] as string)).toBe(true);
    expect((await notices.list('main')).map((notice) => notice.docName)).not.toContain(
      CONFIG_DOC_NAMES[0],
    );
  });

  test('a document whose file lives outside the content folder is checked at that file', async () => {
    const skillFile = join(projectDir, 'home', '.claude', 'skills', 'demo', 'SKILL.md');
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, '# Demo\n');
    const resolveFile = (docName: string): NoticeFile | null =>
      docName === '__skill__/global/demo'
        ? { abs: skillFile, display: '~/.claude/skills/demo/SKILL.md' }
        : null;
    const notices = ledger({ resolveFile });
    notices.record('__skill__/global/demo', 'main', { kind: 'both-kept', kept: KEPT_ONE });

    const listed = async () => (await notices.list('main')).map((notice) => notice.file);
    expect(await listed()).toEqual(['~/.claude/skills/demo/SKILL.md']);
    clock += NOTICE_WITHDRAW_AFTER_MS * 2;
    expect(await listed()).toEqual(['~/.claude/skills/demo/SKILL.md']);

    rmSync(skillFile);
    expect(await listed()).toEqual(['~/.claude/skills/demo/SKILL.md']);
    clock += NOTICE_WITHDRAW_AFTER_MS;
    expect(await listed()).toEqual([]);
  });

  test('a notice is withdrawn once its file has been missing on reads ten seconds apart', async () => {
    seedDoc('notes');
    seedDoc('folder/kept');
    const notices = ledger();
    notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    notices.record('folder/kept', 'main', { kind: 'both-kept', kept: KEPT_ONE });

    rmSync(join(projectDir, 'notes.md'));

    const listed = async () => (await notices.list('main')).map((notice) => notice.docName);
    expect(await listed()).toEqual(['folder/kept', 'notes']);
    expect(await listed()).toEqual(['folder/kept', 'notes']);
    clock += NOTICE_WITHDRAW_AFTER_MS - 1;
    expect(await listed()).toEqual(['folder/kept', 'notes']);
    clock += 1;
    expect(await listed()).toEqual(['folder/kept']);
    expect((await ledger().list('main')).map((notice) => notice.docName)).toEqual(['folder/kept']);
  });

  test('a notice whose document the server holds as vanished is not withdrawn', async () => {
    seedDoc('notes');
    const notices = ledger();
    notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    rmSync(join(projectDir, 'notes.md'));
    held.add('notes');

    const listed = async () => (await notices.list('main')).map((notice) => notice.docName);
    expect(await listed()).toEqual(['notes']);
    clock += NOTICE_WITHDRAW_AFTER_MS * 3;
    expect(await listed()).toEqual(['notes']);

    held.delete('notes');
    expect(await listed()).toEqual(['notes']);
    clock += NOTICE_WITHDRAW_AFTER_MS;
    expect(await listed()).toEqual([]);
  });

  test('a file missing for one read, as during a save that deletes then writes, keeps its notice', async () => {
    seedDoc('notes');
    const notices = ledger();
    notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });

    rmSync(join(projectDir, 'notes.md'));
    expect((await notices.list('main')).map((notice) => notice.docName)).toEqual(['notes']);
    seedDoc('notes');
    expect((await notices.list('main')).map((notice) => notice.docName)).toEqual(['notes']);
    rmSync(join(projectDir, 'notes.md'));
    clock += NOTICE_WITHDRAW_AFTER_MS;
    expect((await notices.list('main')).map((notice) => notice.docName)).toEqual(['notes']);
  });

  test('a renamed document keeps its notice under the new name and file', async () => {
    seedDoc('notes');
    const notices = ledger();
    const id = notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    rmSync(join(projectDir, 'notes.md'));
    seedDoc('archive/notes');

    notices.rename('notes', 'archive/notes', 'main', 'archive/notes.md');

    const listed = await notices.list('main');
    expect(listed).toEqual([
      expect.objectContaining({ id, docName: 'archive/notes', file: 'archive/notes.md' }),
    ]);
    expect((await ledger().list('main')).map((notice) => notice.docName)).toEqual([
      'archive/notes',
    ]);
  });

  test('a notice for an .mdx document keeps its file name and survives a restart before the extensions are known again', async () => {
    seedDoc('guide', '.mdx');
    registerDocExtension('guide', '.mdx');
    ledger().record('guide', 'main', { kind: 'both-kept', kept: KEPT_ONE });

    _resetDocExtensionsForTests();
    const reopened = ledger();

    expect(await reopened.list('main')).toEqual([
      expect.objectContaining({ docName: 'guide', file: 'guide.mdx' }),
    ]);
    expect((await ledger().list('main')).map((notice) => notice.file)).toEqual(['guide.mdx']);
  });

  test('nothing is withdrawn before the server is ready', async () => {
    seedDoc('notes');
    ledger().record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE });
    rmSync(join(projectDir, 'notes.md'));

    expect((await ledger({ ready: false }).list('main')).map((n) => n.docName)).toEqual(['notes']);
    const ready = ledger();
    expect((await ready.list('main')).map((n) => n.docName)).toEqual(['notes']);
    clock += NOTICE_WITHDRAW_AFTER_MS;
    expect((await ready.list('main')).map((n) => n.docName)).toEqual([]);
  });

  test('every change tells the app to refetch, and a read that changes nothing does not', async () => {
    seedDoc('notes');
    const notices = ledger();

    const id = notices.record('notes', 'main', { kind: 'both-kept', kept: KEPT_ONE }) ?? '';
    notices.attachEntry('notes', id, 'b'.repeat(40));
    await notices.list('main');
    notices.dismiss('notes', id);

    expect(signal).toHaveBeenCalledTimes(3);
  });

  test('past the cap the notice touched longest ago is dropped', async () => {
    const notices = ledger();
    for (let i = 0; i <= 200; i++) {
      seedDoc(`doc-${i}`);
      notices.record(`doc-${i}`, 'main', { kind: 'both-kept', kept: KEPT_ONE });
    }

    const docNames = (await notices.list('main')).map((notice) => notice.docName);
    expect(docNames).toHaveLength(200);
    expect(docNames).not.toContain('doc-0');
    expect(docNames[0]).toBe('doc-200');
  });

  describe('with a real history', () => {
    async function realShadow(): Promise<ShadowHandle> {
      await simpleGit(projectDir).init();
      configureTestGitRepository(projectDir);
      return initShadowRepo(projectDir);
    }

    async function movedNoticeWhoseVersionLeftHistory(docName: string) {
      seedDoc(docName);
      const shadow = await realShadow();
      const notices = ledger({ shadow });
      const history = createMergeHistoryRecorder({
        getShadow: () => shadow,
        contentRoot: '',
        getBranch: () => 'main',
        notices,
      });
      await expect(
        history.keptLive(docName, { side: 'theirs', bytes: 'outside\n' }, 'too-large'),
      ).resolves.toBe(true);
      await gcCheckpointRefs(shadow, 'main', {
        ...DEFAULT_CHECKPOINT_RETENTION,
        maxExternalChangeKeptLivePerDocument: 0,
      });
      return notices;
    }

    test('a moved-to-history notice is withdrawn once its version leaves history; a both-kept notice stays until dismissed', async () => {
      seedDoc('kept');
      const notices = await movedNoticeWhoseVersionLeftHistory('moved');
      notices.record('kept', 'main', { kind: 'both-kept', kept: KEPT_ONE });

      expect((await notices.list('main')).map((notice) => notice.docName)).toEqual(['kept']);
    });

    test('a notice recorded while a read is checking history is not withdrawn by that read', async () => {
      const notices = await movedNoticeWhoseVersionLeftHistory('moved');

      const reading = notices.list('main');
      const id = notices.record('moved', 'main', { kind: 'both-kept', kept: KEPT_ONE });
      await reading;

      expect(await notices.list('main')).toEqual([
        expect.objectContaining({ id, docName: 'moved', kind: 'both-kept', events: 2 }),
      ]);
    });

    test('with no history to consult, a moved-to-history notice is kept', async () => {
      seedDoc('moved');
      const notices = ledger();
      notices.record('moved', 'main', {
        kind: 'moved-to-history',
        side: 'theirs',
        reason: 'check-failed',
        entry: 'c'.repeat(40),
      });

      expect((await notices.list('main')).map((notice) => notice.docName)).toEqual(['moved']);
    });
  });
});
