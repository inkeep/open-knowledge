import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  type ConfigValidationError,
  isKnownConfigError,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  CONFIG_FILE_WATCHER_ORIGIN,
  CONFIG_VALIDATION_REVERT_ORIGIN,
} from './config-edit-origin.ts';
import {
  __resetOkignoreTelemetryForTests,
  applyExternalConfigChange,
  type ConfigPersistenceCtx,
  configDocAbsPath,
  isConfigEcho,
  loadConfigDoc,
  storeConfigDoc,
} from './config-persistence.ts';
import * as fsTraced from './fs-traced.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

interface MovedConfigVersion {
  docName: string;
  side: 'ours' | 'theirs';
  bytes: string;
  fileType: string;
}

interface Fixture {
  projectDir: string;
  homedir: string;
  rejections: Array<{ docName: string; error: ConfigValidationError }>;
  moved: MovedConfigVersion[];
  ctx: ConfigPersistenceCtx;
  cleanup: () => void;
}

interface NoticedConfigVersion {
  docName: string;
  side: string;
  where: 'history' | 'backup';
  entry: string;
}

const noticed: NoticedConfigVersion[] = [];
let duringSave: (() => void) | null = null;

function recordingHistory(
  moved: MovedConfigVersion[],
  saves: () => boolean = () => true,
): NonNullable<ConfigPersistenceCtx['history']> {
  return {
    saveNoEngine: async (docName, displaced, fileType) => {
      duringSave?.();
      if (!saves()) return null;
      moved.push({ docName, ...displaced, fileType });
      return `entry-${moved.length}`;
    },
    noticeNoEngine: (docName, side, _fileType, copy) => {
      noticed.push({
        docName,
        side,
        where: copy.where,
        entry: copy.where === 'history' ? copy.entry : copy.backup.display,
      });
    },
  };
}

let historySaves = true;

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ok-config-persist-'));
  const projectDir = join(root, 'project');
  const homedir = join(root, 'home');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homedir, { recursive: true });
  const rejections: Fixture['rejections'] = [];
  const moved: MovedConfigVersion[] = [];
  historySaves = true;
  noticed.length = 0;
  duringSave = null;
  const ctx: ConfigPersistenceCtx = {
    projectDir,
    lkgCache: new Map(),
    agreedDisk: new Map(),
    homedirOverride: homedir,
    onConfigRejected: (docName, error) => {
      rejections.push({ docName, error });
    },
    history: recordingHistory(moved, () => historySaves),
  };
  return {
    projectDir,
    homedir,
    rejections,
    moved,
    ctx,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

function backupsIn(home: string): string[] {
  const root = join(home, '.ok', 'edit-backups', 'discarded');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'));
}

function blockBackups(home: string): void {
  mkdirSync(join(home, '.ok'), { recursive: true });
  writeFileSync(join(home, '.ok', 'edit-backups'), 'not a folder');
}

function writeWorkspaceConfig(projectDir: string, content: string): string {
  const path = join(projectDir, '.ok', 'config.yml');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

function writeProjectLocalConfig(projectDir: string, content: string): string {
  const path = join(projectDir, '.ok', 'local', 'config.yml');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

let fx: Fixture;

beforeEach(() => {
  fx = makeFixture();
  resetMetrics();
});

afterEach(() => {
  vi.restoreAllMocks();
  fx.cleanup();
});

describe('settings outside changes: agreed version, races and deferral', () => {
  const SAVED = 'mcp:\n  autoStart: true\n';
  const EDIT = 'mcp:\n  autoStart: true\n# note\n';

  function projectPath(): string {
    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }

  function loaded(fileBytes: string | null): Y.Doc {
    const path = projectPath();
    if (fileBytes !== null) writeFileSync(path, fileBytes, 'utf-8');
    const doc = new Y.Doc();
    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, fx.ctx);
    return doc;
  }

  function type(doc: Y.Doc, text: string): void {
    const ytext = doc.getText('source');
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, text);
    }, 'person');
  }

  test('an empty settings file at load is not an outside change: the first edit is written', async () => {
    const doc = loaded('');
    type(doc, EDIT);

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, 'person', fx.ctx)).toBe('persisted');

    expect(readFileSync(projectPath(), 'utf-8')).toBe(EDIT);
    expect(doc.getText('source').toString()).toBe(EDIT);
    expect(fx.moved).toEqual([]);
    expect(noticed).toEqual([]);
  });

  test('a settings file that was invalid at load is not an outside change: the first valid edit is written', async () => {
    const doc = loaded('contentRules: [unclosed\n');
    type(doc, EDIT);

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, 'person', fx.ctx)).toBe('persisted');

    expect(readFileSync(projectPath(), 'utf-8')).toBe(EDIT);
    expect(fx.moved).toEqual([]);
    expect(noticed).toEqual([]);
  });

  test('two outside versions arriving during one history save end with the newer one applied, noticed once', async () => {
    const doc = loaded(SAVED);
    type(doc, EDIT);
    const w1 = 'mcp:\n  autoStart: false\n';
    const w2 = 'mcp:\n  autoStart: false\n# outside again\n';

    const [first, second] = await Promise.all([
      applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, w1, fx.ctx),
      applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, w2, fx.ctx),
    ]);

    expect([first, second]).toEqual(['applied', 'applied']);
    expect(doc.getText('source').toString()).toBe(w2);
    expect(fx.moved.map((version) => version.bytes)).toEqual([EDIT]);
    expect(noticed).toHaveLength(1);
  });

  test('typing through every history save defers the outside version to the pending save, with no notice', async () => {
    const doc = loaded(SAVED);
    type(doc, EDIT);
    let typed = 0;
    duringSave = () => {
      typed += 1;
      type(doc, `${EDIT}# still typing ${typed}\n`);
    };

    expect(
      await applyExternalConfigChange(
        doc,
        CONFIG_DOC_NAME_PROJECT,
        'mcp:\n  autoStart: false\n',
        fx.ctx,
      ),
    ).toBe('held');

    expect(doc.getText('source').toString()).toBe(`${EDIT}# still typing 3\n`);
    expect(fx.moved).toHaveLength(3);
    expect(noticed).toEqual([]);
    expect(getMetrics().configOutsideChange).toEqual({ 'intake:deferred': 1 });
  });

  test('an empty settings document has nothing unsaved for the intake to keep', async () => {
    const doc = loaded(SAVED);
    type(doc, '');

    expect(
      await applyExternalConfigChange(
        doc,
        CONFIG_DOC_NAME_PROJECT,
        'mcp:\n  autoStart: false\n',
        fx.ctx,
      ),
    ).toBe('applied');

    expect(fx.moved).toEqual([]);
    expect(getMetrics().configOutsideChange).toEqual({ 'intake:applied': 1 });
  });

  test('a valid outside version written during the history save of an invalid one wins, with the edit kept', async () => {
    const path = projectPath();
    const doc = loaded(SAVED);
    type(doc, EDIT);
    writeFileSync(path, 'mcp: [unclosed\n', 'utf-8');
    const later = 'mcp:\n  autoStart: false\n';
    let planted = false;
    duringSave = () => {
      if (planted) return;
      planted = true;
      writeFileSync(path, later, 'utf-8');
    };

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, 'person', fx.ctx)).toBe('reconciled');

    expect(readFileSync(path, 'utf-8')).toBe(later);
    expect(doc.getText('source').toString()).toBe(later);
    expect(fx.moved.map((version) => [version.side, version.bytes])).toEqual([
      ['theirs', 'mcp: [unclosed\n'],
      ['ours', EDIT],
    ]);
    expect(noticed.map((notice) => notice.side)).toEqual(['ours']);
  });

  test('an outside version written between the compare and the rename is not written over', async () => {
    const path = projectPath();
    const doc = loaded(SAVED);
    type(doc, EDIT);
    const between = 'mcp:\n  autoStart: false\n';
    const write = fsTraced.tracedWriteFile;
    let planted = false;
    vi.spyOn(fsTraced, 'tracedWriteFile').mockImplementation(async (...args) => {
      await write(...args);
      if (planted) return;
      planted = true;
      writeFileSync(path, between, 'utf-8');
    });

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, 'person', fx.ctx)).toBe('reconciled');

    expect(readFileSync(path, 'utf-8')).toBe(between);
    expect(fx.moved.map((version) => version.bytes)).toEqual([EDIT]);
    expect(getMetrics().storeRestatRefused).toBe(1);
  });
});

describe('configDocAbsPath', () => {
  test('project doc resolves under projectDir/.ok/config.yml', () => {
    expect(configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx)).toBe(
      join(fx.projectDir, '.ok', 'config.yml'),
    );
  });

  test('user doc resolves under homedirOverride/.ok/global.yml', () => {
    expect(configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx)).toBe(
      join(fx.homedir, '.ok', 'global.yml'),
    );
  });

  test('project-local doc resolves under projectDir/.ok/local/config.yml', () => {
    expect(configDocAbsPath(CONFIG_DOC_NAME_PROJECT_LOCAL, fx.ctx)).toBe(
      join(fx.projectDir, '.ok', 'local', 'config.yml'),
    );
  });

  test('okignore doc resolves under projectDir/.okignore when contentDir is unset', () => {
    expect(configDocAbsPath(CONFIG_DOC_NAME_OKIGNORE, fx.ctx)).toBe(
      join(fx.projectDir, '.okignore'),
    );
  });

  test('okignore doc resolves under contentDir/.okignore when contentDir is set', () => {
    const contentDir = join(fx.projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const ctxWithContent: ConfigPersistenceCtx = { ...fx.ctx, contentDir };
    expect(configDocAbsPath(CONFIG_DOC_NAME_OKIGNORE, ctxWithContent)).toBe(
      join(contentDir, '.okignore'),
    );
  });

  test('throws on a non-config doc name', () => {
    expect(() => configDocAbsPath('not/a/config/doc', fx.ctx)).toThrow(/not a config doc/i);
  });
});

describe('loadConfigDoc — cold start', () => {
  test('seeds Y.Text with disk content + LKG = bytes when valid', () => {
    const yaml = 'mcp:\n  autoStart: false\n';
    writeWorkspaceConfig(fx.projectDir, yaml);
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, fx.ctx);

    expect(doc.getText('source').toString()).toBe(yaml);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe(yaml);
  });

  test('missing disk file → empty Y.Text + LKG = serialized defaults', () => {
    const doc = new Y.Doc();
    loadConfigDoc(doc, CONFIG_DOC_NAME_USER, fx.ctx);
    expect(doc.getText('source').toString()).toBe('');
    const lkg = fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER);
    expect(lkg).toBeDefined();
    expect(lkg).toContain('content:');
    expect(lkg).toContain('dir: .');
  });

  test('broken YAML on disk → seeds Y.Text with raw bytes + LKG = defaults', () => {
    const broken = 'mcp:\n  autoStart: !!!!!\n';
    writeWorkspaceConfig(fx.projectDir, broken);
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, fx.ctx);

    expect(doc.getText('source').toString()).toBe(broken);
    const lkg = fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT);
    expect(lkg).toBeDefined();
    expect(lkg).not.toBe(broken);
  });

  test('seed transaction uses CONFIG_VALIDATION_REVERT_ORIGIN', () => {
    const yaml = 'mcp:\n  autoStart: false\n';
    writeWorkspaceConfig(fx.projectDir, yaml);
    const doc = new Y.Doc();

    let observedOrigin: unknown = null;
    doc.on('afterTransaction', (tx) => {
      observedOrigin = tx.origin;
    });

    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, fx.ctx);

    expect(observedOrigin).toBe(CONFIG_VALIDATION_REVERT_ORIGIN);
  });

  test('idempotent: re-loading does not double-seed Y.Text', () => {
    const yaml = 'mcp:\n  autoStart: false\n';
    writeWorkspaceConfig(fx.projectDir, yaml);
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, fx.ctx);
    const firstLength = doc.getText('source').length;
    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, fx.ctx);

    expect(doc.getText('source').length).toBe(firstLength);
  });

  test('project-local doc seeds Y.Text from <projectDir>/.ok/local/config.yml', () => {
    const yaml = 'autoSync:\n  enabled: true\n';
    writeProjectLocalConfig(fx.projectDir, yaml);
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT_LOCAL, fx.ctx);

    expect(doc.getText('source').toString()).toBe(yaml);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT_LOCAL)).toBe(yaml);
  });
});

describe('storeConfigDoc — happy path', () => {
  test('valid Y.Text content writes disk and updates LKG', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, '');
    doc.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe('mcp:\n  autoStart: false\n');
    expect(fx.rejections).toHaveLength(0);
  });

  test('lazy first-write: missing parent dir is created (mkdir -p)', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'mcp:\n  autoStart: true\n');

    expect(existsSync(join(fx.homedir, '.ok'))).toBe(false);
    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    expect(existsSync(path)).toBe(true);
  });

  test('atomic-write semantics: no leftover .tmp.* files on success', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    const dir = join(fx.projectDir, '.ok');
    const entries = readdirSafe(dir);
    expect(entries.filter((e) => e.includes('.tmp.'))).toHaveLength(0);
    expect(entries).toContain('config.yml');
  });
});

describe('storeConfigDoc — cross-process reconciliation (file lock)', () => {
  function makeSecondCtxSharingHomedir(primary: Fixture): {
    ctx: ConfigPersistenceCtx;
    rejections: Array<{ docName: string; error: ConfigValidationError }>;
    moved: MovedConfigVersion[];
  } {
    const rejections: Array<{ docName: string; error: ConfigValidationError }> = [];
    const moved: MovedConfigVersion[] = [];
    return {
      rejections,
      moved,
      ctx: {
        projectDir: primary.projectDir,
        lkgCache: new Map(),
        agreedDisk: new Map(),
        homedirOverride: primary.homedir,
        onConfigRejected: (docName, error) => {
          rejections.push({ docName, error });
        },
        history: recordingHistory(moved),
      },
    };
  }

  test('a valid outside version wins at the store and the unsaved edit it displaces goes to history', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: false\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx);

    expect(outcome).toBe('reconciled');
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe('mcp:\n  autoStart: false\n');
    expect(fx.rejections).toHaveLength(0);
    expect(fx.moved).toEqual([
      {
        docName: CONFIG_DOC_NAME_USER,
        side: 'ours',
        bytes: 'appearance:\n  theme: dark\n',
        fileType: 'config',
      },
    ]);
    expect(getMetrics().configOutsideChange).toEqual({ 'store:applied-displaced': 1 });
  });

  test('a valid outside version that history cannot take applies once the unsaved edit is in the backup folder', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: false\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');
    historySaves = false;

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx)).toBe('reconciled');
    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    expect(backupsIn(fx.homedir)).toEqual(['appearance:\n  theme: dark\n']);
    expect(noticed).toEqual([
      {
        docName: CONFIG_DOC_NAME_USER,
        side: 'ours',
        where: 'backup',
        entry: expect.stringMatching(
          /^~\/\.ok\/edit-backups\/discarded\/projects\/[0-9a-f]{8}\/[^/]+\/[^/]+\.yml$/,
        ),
      },
    ]);
    expect(getMetrics().configOutsideChange).toEqual({ 'store:applied-displaced': 1 });
  });

  test('a valid outside version that neither history nor the backup folder can take leaves the unsaved edit live and nothing written', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: false\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');
    historySaves = false;
    blockBackups(fx.homedir);

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx)).toEqual({
      kind: 'held',
      cause: 'no-history-or-backup',
    });
    expect(doc.getText('source').toString()).toBe('appearance:\n  theme: dark\n');
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe('mcp:\n  autoStart: true\n');
    expect(noticed).toEqual([]);
    expect(getMetrics().configOutsideChange).toEqual({ 'store:held-no-history-or-backup': 1 });
  });

  test('an outside version that is not valid UTF-8 is neither applied nor written over, at the save or the intake', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    const latin1 = Buffer.from('appearance:\n  theme: caf\u00e9\n', 'latin1');
    writeFileSync(path, latin1);
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx)).toMatchObject({
      kind: 'held',
      cause: 'not-utf8',
      path,
    });
    expect(
      await applyExternalConfigChange(doc, CONFIG_DOC_NAME_USER, latin1.toString('utf8'), fx.ctx),
    ).toBe('held');

    expect(readFileSync(path).equals(latin1)).toBe(true);
    expect(doc.getText('source').toString()).toBe('appearance:\n  theme: dark\n');
    expect(fx.moved).toEqual([]);
    expect(backupsIn(fx.homedir)).toEqual([]);
    expect(getMetrics().configOutsideChange).toEqual({
      'store:held-not-utf8': 1,
      'intake:held-not-utf8': 1,
    });
  });

  test('two servers writing the SAME shared file: second store reconciles, first writer wins', async () => {
    const second = makeSecondCtxSharingHomedir(fx);
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    expect(configDocAbsPath(CONFIG_DOC_NAME_USER, second.ctx)).toBe(path);

    const v0 = 'mcp:\n  autoStart: true\n';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, v0, 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, v0);
    second.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, v0);

    const docA = new Y.Doc();
    docA.getText('source').insert(0, 'mcp:\n  autoStart: false\n');
    const outcomeA = await storeConfigDoc(docA, CONFIG_DOC_NAME_USER, undefined, fx.ctx);
    expect(outcomeA).toBe('persisted');
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');

    const docB = new Y.Doc();
    docB.getText('source').insert(0, 'appearance:\n  theme: dark\n');
    const outcomeB = await storeConfigDoc(docB, CONFIG_DOC_NAME_USER, undefined, second.ctx);

    expect(outcomeB).toBe('reconciled');
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
    expect(docB.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    expect(second.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe('mcp:\n  autoStart: false\n');

    expect(docB.getText('source').toString()).not.toContain('theme: dark');
    expect(second.moved).toEqual([
      {
        docName: CONFIG_DOC_NAME_USER,
        side: 'ours',
        bytes: 'appearance:\n  theme: dark\n',
        fileType: 'config',
      },
    ]);
  });

  test('disk matches LKG: writes proceed normally (no spurious reconciliation)', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: true\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe('mcp:\n  autoStart: false\n');
  });

  test('lockfile is cleaned up after each store', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test('disk diverged but content is INVALID YAML: the outside version goes to history, then our valid content is written', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: !!!!!!!!!!!!!!\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    expect(readFileSync(path, 'utf-8')).toBe('appearance:\n  theme: dark\n');
    expect(doc.getText('source').toString()).toBe('appearance:\n  theme: dark\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe('appearance:\n  theme: dark\n');
    expect(fx.rejections).toHaveLength(0);
    expect(fx.moved).toEqual([
      {
        docName: CONFIG_DOC_NAME_USER,
        side: 'theirs',
        bytes: 'mcp:\n  autoStart: !!!!!!!!!!!!!!\n',
        fileType: 'config',
      },
    ]);
    expect(getMetrics().configOutsideChange).toEqual({ 'store:invalid-kept-live': 1 });
  });

  test('an invalid outside version that history cannot take goes to the backup folder before our settings are written', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: !!!!!!!!!!!!!!\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');
    historySaves = false;

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx)).toBe('persisted');
    expect(readFileSync(path, 'utf-8')).toBe('appearance:\n  theme: dark\n');
    expect(backupsIn(fx.homedir)).toEqual(['mcp:\n  autoStart: !!!!!!!!!!!!!!\n']);
    expect(noticed.map(({ side, where }) => ({ side, where }))).toEqual([
      { side: 'theirs', where: 'backup' },
    ]);
  });

  test('an invalid outside version that neither history nor the backup folder can take is not written over', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: !!!!!!!!!!!!!!\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');
    historySaves = false;
    blockBackups(fx.homedir);

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    expect(await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx)).toEqual({
      kind: 'held',
      cause: 'no-history-or-backup',
    });
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: !!!!!!!!!!!!!!\n');
    expect(doc.getText('source').toString()).toBe('appearance:\n  theme: dark\n');
  });

  test('mkdir failure surfaces as write-failed via onConfigRejected; no exception escapes', async () => {
    const parentPath = join(fx.homedir, '.ok');
    writeFileSync(parentPath, 'placeholder', 'utf-8');

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, '');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx);

    expect(outcome).toBe('write-failed');
    expect(fx.rejections).toHaveLength(1);
    expect(fx.rejections[0]?.docName).toBe(CONFIG_DOC_NAME_USER);
    expect(fx.rejections[0]?.error.code).toBe('WRITE_ERROR');
  });

  test('non-ENOENT read error inside the lock surfaces as write-failed (does NOT silently fall through to write)', async () => {
    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    mkdirSync(path, { recursive: true });
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('write-failed');
    expect(fx.rejections).toHaveLength(1);
    expect(fx.rejections[0]?.error.code).toBe('WRITE_ERROR');
  });
});

describe('storeConfigDoc — write failures', () => {
  test('disk write failure surfaces via onConfigRejected with WRITE_ERROR; no leftover tmp files', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    const absPath = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    mkdirSync(absPath, { recursive: true });

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('write-failed');
    expect(fx.rejections).toHaveLength(1);
    expect(fx.rejections[0]?.docName).toBe(CONFIG_DOC_NAME_PROJECT);
    expect(fx.rejections[0]?.error.code).toBe('WRITE_ERROR');

    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBeUndefined();

    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');

    const dir = join(fx.projectDir, '.ok');
    const entries = readdirSafe(dir);
    expect(entries.filter((e) => e.includes('.tmp.'))).toHaveLength(0);
  });
});

describe('storeConfigDoc — short-circuits', () => {
  test('entry-gate: lastTransactionOrigin === CONFIG_VALIDATION_REVERT_ORIGIN → no-op', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    doc.getText('source').insert(0, 'totally garbage content not yaml');

    const outcome = await storeConfigDoc(
      doc,
      CONFIG_DOC_NAME_PROJECT,
      CONFIG_VALIDATION_REVERT_ORIGIN,
      fx.ctx,
    );

    expect(outcome).toBe('no-op');
    expect(existsSync(join(fx.projectDir, '.ok', 'config.yml'))).toBe(false);
    expect(fx.rejections).toHaveLength(0);
  });

  test('empty Y.Text → no-op (lazy file creation)', async () => {
    const doc = new Y.Doc();
    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(existsSync(join(fx.projectDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('YAML doc: empty Y.Text with non-empty LKG → no-op (YAML scope preserved)', async () => {
    const yaml = 'mcp:\n  autoStart: true\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, yaml);
    writeWorkspaceConfig(fx.projectDir, yaml);
    const doc = new Y.Doc();

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(readFileSync(configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx), 'utf-8')).toBe(yaml);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe(yaml);
    expect(fx.rejections).toHaveLength(0);
  });

  test('content equals LKG → no-op (no spurious rewrite)', async () => {
    const yaml = 'mcp:\n  autoStart: true\n';
    writeWorkspaceConfig(fx.projectDir, yaml);
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, yaml);
    doc.getText('source').insert(0, yaml);

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
  });
});

describe('storeConfigDoc — rejection + revert', () => {
  test('invalid YAML → reverts Y.Text to LKG + fires onConfigRejected', async () => {
    const lkgYaml = 'mcp:\n  autoStart: false\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, lkgYaml);
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'not: [valid: yaml: at: all\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('reverted');
    expect(doc.getText('source').toString()).toBe(lkgYaml);
    expect(fx.rejections).toHaveLength(1);
    const r = fx.rejections[0];
    expect(r).toBeDefined();
    if (!r) throw new Error('rejection missing');
    expect(r.docName).toBe(CONFIG_DOC_NAME_PROJECT);
    expect(isKnownConfigError(r.error)).toBe(true);
    if (isKnownConfigError(r.error)) {
      expect(r.error.code).toBe('YAML_PARSE');
    }
    expect(existsSync(join(fx.projectDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('schema-invalid → reverts Y.Text + structured SCHEMA_INVALID error with issues', async () => {
    const lkgYaml = 'content:\n  dir: docs\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, lkgYaml);
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: midnight\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('reverted');
    expect(doc.getText('source').toString()).toBe(lkgYaml);
    expect(fx.rejections).toHaveLength(1);
    const err = fx.rejections[0]?.error;
    expect(err).toBeDefined();
    if (!err || !isKnownConfigError(err)) throw new Error('expected known error');
    expect(err.code).toBe('SCHEMA_INVALID');
    if (err.code === 'SCHEMA_INVALID') {
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues[0]?.path).toEqual(['appearance', 'theme']);
    }
  });

  test('cold-start no LKG entry + invalid mutation → falls back to schema defaults', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: midnight\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('reverted');
    const reverted = doc.getText('source').toString();
    expect(reverted).toContain('content:');
    expect(reverted).toContain('dir: .');
    const lkg = fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT);
    expect(lkg).toBeDefined();
    expect(lkg).toBe(reverted);
    expect(fx.rejections).toHaveLength(1);
  });

  test('revert transaction uses CONFIG_VALIDATION_REVERT_ORIGIN — entry-gate would skip a re-fire', async () => {
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'broken: [yaml\n');

    const observedOrigins: unknown[] = [];
    doc.on('afterTransaction', (tx) => {
      observedOrigins.push(tx.origin);
    });

    await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(observedOrigins.some((o) => o === CONFIG_VALIDATION_REVERT_ORIGIN)).toBe(true);
  });

  test('back-to-back: invalid mutation reverts; subsequent valid mutation persists', async () => {
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    const doc = new Y.Doc();

    doc.getText('source').insert(0, 'foo: [bar: [baz\n');
    const r1 = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);
    expect(r1).toBe('reverted');

    doc.transact(() => {
      const t = doc.getText('source');
      t.delete(0, t.length);
      t.insert(0, 'mcp:\n  autoStart: false\n');
    });
    const r2 = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);
    expect(r2).toBe('persisted');
    expect(readFileSync(join(fx.projectDir, '.ok', 'config.yml'), 'utf-8')).toBe(
      'mcp:\n  autoStart: false\n',
    );
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe('mcp:\n  autoStart: false\n');
  });
});

describe('persistence extension dispatch — config-doc integration', () => {
  test('config-doc onLoadDocument seeds Y.Text + LKG from disk', async () => {
    const { createPersistenceExtension } = await import('./persistence.ts');
    const yaml = 'mcp:\n  autoStart: false\n';
    writeWorkspaceConfig(fx.projectDir, yaml);
    const rejections: Array<{ docName: string; error: ConfigValidationError }> = [];

    const handle = createPersistenceExtension({
      mergeHistory: null,
      ingestDiskAtStore: null,
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigRejected: (docName, error) => rejections.push({ docName, error }),
    });

    const document = new Y.Doc();
    await handle.extension.onLoadDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);

    expect(document.getText('source').toString()).toBe(yaml);
  });

  test('config-doc onStoreDocument validates + writes disk', async () => {
    const { createPersistenceExtension } = await import('./persistence.ts');
    const handle = createPersistenceExtension({
      mergeHistory: null,
      ingestDiskAtStore: null,
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
    });

    const document = new Y.Doc();
    document.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    await handle.extension.onStoreDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      lastTransactionOrigin: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);

    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
  });

  test('throwing onConfigPersisted does not surface as a store failure; persist still lands on disk', async () => {
    const { createPersistenceExtension } = await import('./persistence.ts');
    const notified: string[] = [];

    const handle = createPersistenceExtension({
      mergeHistory: null,
      ingestDiskAtStore: null,
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigPersisted: (docName) => {
        notified.push(docName);
        throw new Error('consumer notify failed');
      },
    });

    const document = new Y.Doc();
    document.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    await handle.extension.onStoreDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      lastTransactionOrigin: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);

    expect(notified).toEqual([CONFIG_DOC_NAME_PROJECT]);
    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
  });

  test('onConfigPersisted fires only on durable outcomes — a no-op store does not notify', async () => {
    const { createPersistenceExtension } = await import('./persistence.ts');
    const notified: string[] = [];

    const handle = createPersistenceExtension({
      mergeHistory: null,
      ingestDiskAtStore: null,
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigPersisted: (docName) => {
        notified.push(docName);
      },
    });

    const document = new Y.Doc();
    document.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    await handle.extension.onStoreDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      lastTransactionOrigin: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);
    expect(notified).toEqual([CONFIG_DOC_NAME_PROJECT]);

    await handle.extension.onStoreDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      lastTransactionOrigin: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);
    expect(notified).toEqual([CONFIG_DOC_NAME_PROJECT]);
  });

  test('config-doc onStoreDocument fires onConfigRejected callback through ctx', async () => {
    const { createPersistenceExtension } = await import('./persistence.ts');
    const rejections: Array<{ docName: string; error: ConfigValidationError }> = [];

    const handle = createPersistenceExtension({
      mergeHistory: null,
      ingestDiskAtStore: null,
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigRejected: (docName, error) => rejections.push({ docName, error }),
    });

    const document = new Y.Doc();

    await handle.extension.onLoadDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);

    document.getText('source').insert(0, 'foo: [bar: [baz\n');

    await handle.extension.onStoreDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      lastTransactionOrigin: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.docName).toBe(CONFIG_DOC_NAME_PROJECT);
    expect(existsSync(join(fx.projectDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('non-config doc names skip the config branch entirely', async () => {
    const { createPersistenceExtension } = await import('./persistence.ts');
    const rejections: Array<{ docName: string; error: ConfigValidationError }> = [];
    const handle = createPersistenceExtension({
      mergeHistory: null,
      ingestDiskAtStore: null,
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigRejected: (docName, error) => rejections.push({ docName, error }),
    });

    const document = new Y.Doc();
    document.getText('source').insert(0, 'this is not yaml: but: malformed: [');

    try {
      await handle.extension.onStoreDocument?.({
        document,
        documentName: 'notes/intro',
        lastTransactionOrigin: undefined,
        // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
      } as any);
    } catch {}

    expect(rejections).toHaveLength(0);
  });
});

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

describe('applyExternalConfigChange', () => {
  test('valid external content updates Y.Text under CONFIG_FILE_WATCHER_ORIGIN + LKG', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'theme: light\n');
    doc.getText('source').insert(0, 'theme: light\n');

    let observedOrigin: unknown = null;
    doc.on('afterTransaction', (tx) => {
      observedOrigin = tx.origin;
    });

    const newContent = 'theme: dark\n';
    const outcome = await applyExternalConfigChange(
      doc,
      CONFIG_DOC_NAME_PROJECT,
      newContent,
      fx.ctx,
    );

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(newContent);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe(newContent);
    expect(observedOrigin).toBe(CONFIG_FILE_WATCHER_ORIGIN);
    expect(fx.rejections).toHaveLength(0);
  });

  test('a valid outside version applies over an unsaved edit, which goes to history first', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    doc.getText('source').insert(0, 'mcp:\n  autoStart: true\n# note\n');

    const outcome = await applyExternalConfigChange(
      doc,
      CONFIG_DOC_NAME_PROJECT,
      'mcp:\n  autoStart: false\n',
      fx.ctx,
    );

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    expect(fx.moved).toEqual([
      {
        docName: CONFIG_DOC_NAME_PROJECT,
        side: 'ours',
        bytes: 'mcp:\n  autoStart: true\n# note\n',
        fileType: 'config',
      },
    ]);
    expect(getMetrics().configOutsideChange).toEqual({ 'intake:applied-displaced': 1 });
  });

  test('a valid outside version with nothing unsaved applies with no history entry', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    doc.getText('source').insert(0, 'mcp:\n  autoStart: true\n');

    await applyExternalConfigChange(
      doc,
      CONFIG_DOC_NAME_PROJECT,
      'mcp:\n  autoStart: false\n',
      fx.ctx,
    );

    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    expect(fx.moved).toEqual([]);
    expect(getMetrics().configOutsideChange).toEqual({ 'intake:applied': 1 });
  });

  test('when history cannot take the unsaved edit, the backup folder does and the outside version applies', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    doc.getText('source').insert(0, 'mcp:\n  autoStart: true\n# note\n');
    historySaves = false;

    expect(
      await applyExternalConfigChange(
        doc,
        CONFIG_DOC_NAME_PROJECT,
        'mcp:\n  autoStart: false\n',
        fx.ctx,
      ),
    ).toBe('applied');
    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    expect(backupsIn(fx.homedir)).toEqual(['mcp:\n  autoStart: true\n# note\n']);
  });

  test('when neither history nor the backup folder can take the unsaved edit, the outside version is not applied over it', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    doc.getText('source').insert(0, 'mcp:\n  autoStart: true\n# note\n');
    historySaves = false;
    blockBackups(fx.homedir);

    expect(
      await applyExternalConfigChange(
        doc,
        CONFIG_DOC_NAME_PROJECT,
        'mcp:\n  autoStart: false\n',
        fx.ctx,
      ),
    ).toBe('held');
    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: true\n# note\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe('mcp:\n  autoStart: true\n');
  });

  test('content equal to LKG short-circuits: no mutation, no rejection', async () => {
    const doc = new Y.Doc();
    const yaml = 'mcp:\n  autoStart: false\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, yaml);
    doc.getText('source').insert(0, yaml);

    let mutationCount = 0;
    doc.on('afterTransaction', (tx) => {
      if (tx.origin === CONFIG_FILE_WATCHER_ORIGIN) mutationCount++;
    });

    const outcome = await applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, yaml, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(isConfigEcho(CONFIG_DOC_NAME_PROJECT, yaml, fx.ctx)).toBe(true);
    expect(mutationCount).toBe(0);
    expect(fx.rejections).toHaveLength(0);
  });

  test('null document → no-op (document not loaded yet)', async () => {
    const outcome = await applyExternalConfigChange(
      null,
      CONFIG_DOC_NAME_PROJECT,
      'theme: dark\n',
      fx.ctx,
    );
    expect(outcome).toBe('no-op');
    expect(isConfigEcho(CONFIG_DOC_NAME_PROJECT, 'theme: dark\n', fx.ctx)).toBe(false);
    expect(isConfigEcho(CONFIG_DOC_NAME_PROJECT, '', fx.ctx)).toBe(false);
    expect(fx.rejections).toHaveLength(0);
  });

  test.each(['mcp:\n  autoStart: false\n', ''])(
    'distinguishes cached echoes from new content after unloading (%j)',
    async (content) => {
      const doc = new Y.Doc();
      expect(await applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, content, fx.ctx)).toBe(
        'applied',
      );
      doc.destroy();

      expect(isConfigEcho(CONFIG_DOC_NAME_PROJECT, content, fx.ctx)).toBe(true);
      expect(await applyExternalConfigChange(null, CONFIG_DOC_NAME_PROJECT, content, fx.ctx)).toBe(
        'no-op',
      );
      const changed = 'mcp:\n  autoStart: true\n';
      expect(isConfigEcho(CONFIG_DOC_NAME_PROJECT, changed, fx.ctx)).toBe(false);
      expect(await applyExternalConfigChange(null, CONFIG_DOC_NAME_PROJECT, changed, fx.ctx)).toBe(
        'no-op',
      );
      expect(isConfigEcho(CONFIG_DOC_NAME_PROJECT, changed, fx.ctx)).toBe(false);
    },
  );

  test('YAML parse error → rejected; Y.Text NOT mutated; onConfigRejected fired', async () => {
    const doc = new Y.Doc();
    const valid = 'theme: light\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, valid);
    doc.getText('source').insert(0, valid);

    const broken = 'theme: !!!!!\n';
    const outcome = await applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, broken, fx.ctx);

    expect(outcome).toBe('rejected');
    expect(doc.getText('source').toString()).toBe(valid);
    expect(fx.rejections).toHaveLength(1);
    expect(fx.rejections[0]?.docName).toBe(CONFIG_DOC_NAME_PROJECT);
    const error = fx.rejections[0]?.error;
    expect(error).toBeDefined();
    if (error && isKnownConfigError(error)) {
      expect(error.code).toBe('YAML_PARSE');
    }
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe(valid);
  });

  test('schema-invalid external content → rejected with structured issues', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'content:\n  dir: docs\n');

    const invalid = 'appearance:\n  theme: midnight\n';
    const outcome = await applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, invalid, fx.ctx);

    expect(outcome).toBe('rejected');
    expect(fx.rejections).toHaveLength(1);
    const error = fx.rejections[0]?.error;
    expect(error).toBeDefined();
    if (error && isKnownConfigError(error) && error.code === 'SCHEMA_INVALID') {
      expect(error.issues.length).toBeGreaterThan(0);
      expect(error.issues[0]?.path).toEqual(['appearance', 'theme']);
    } else {
      throw new Error('expected SCHEMA_INVALID error');
    }
  });

  test('LKG-undefined + valid external content → applied; LKG seeded', async () => {
    const doc = new Y.Doc();
    expect(fx.ctx.lkgCache.has(CONFIG_DOC_NAME_USER)).toBe(false);

    const yaml = 'theme: dark\n';
    const outcome = await applyExternalConfigChange(doc, CONFIG_DOC_NAME_USER, yaml, fx.ctx);

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(yaml);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe(yaml);
  });

  test('project-local: external content propagates to Y.Text + LKG', async () => {
    const doc = new Y.Doc();
    expect(fx.ctx.lkgCache.has(CONFIG_DOC_NAME_PROJECT_LOCAL)).toBe(false);

    const yaml = 'autoSync:\n  enabled: true\n';
    const outcome = await applyExternalConfigChange(
      doc,
      CONFIG_DOC_NAME_PROJECT_LOCAL,
      yaml,
      fx.ctx,
    );

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(yaml);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT_LOCAL)).toBe(yaml);
  });

  test('Y.Text mutation under CONFIG_FILE_WATCHER_ORIGIN does NOT trigger storeConfigDoc', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'theme: light\n');
    doc.getText('source').insert(0, 'theme: light\n');

    await applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, 'theme: dark\n', fx.ctx);

    const outcome = await storeConfigDoc(
      doc,
      CONFIG_DOC_NAME_PROJECT,
      CONFIG_FILE_WATCHER_ORIGIN,
      fx.ctx,
    );
    expect(outcome).toBe('no-op');
    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    expect(existsSync(path)).toBe(false);
  });
});

describe('okignore — loadConfigDoc cold start', () => {
  test('missing disk file → empty Y.Text + LKG = empty string (not schema-defaults)', () => {
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, fx.ctx);

    expect(doc.getText('source').toString()).toBe('');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe('');
  });

  test('valid disk content seeds Y.Text + LKG with raw bytes', () => {
    writeFileSync(
      join(fx.projectDir, '.okignore'),
      '# user comment\n\ndrafts/\n*.draft.md\n',
      'utf-8',
    );
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, fx.ctx);

    const seeded = '# user comment\n\ndrafts/\n*.draft.md\n';
    expect(doc.getText('source').toString()).toBe(seeded);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe(seeded);
  });

  test('invalid disk content (whitespace-only line) seeds raw bytes but LKG falls back to empty string', () => {
    const broken = 'drafts/\n   \n*.draft.md\n';
    writeFileSync(join(fx.projectDir, '.okignore'), broken, 'utf-8');
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, fx.ctx);

    expect(doc.getText('source').toString()).toBe(broken);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe('');
  });

  test('contentDir override resolves to <contentDir>/.okignore (not projectDir)', () => {
    const contentDir = join(fx.projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, '.okignore'), 'drafts/\n', 'utf-8');
    const doc = new Y.Doc();
    const ctx: ConfigPersistenceCtx = { ...fx.ctx, contentDir };

    loadConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, ctx);

    expect(doc.getText('source').toString()).toBe('drafts/\n');
    expect(ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe('drafts/\n');
  });
});

describe('okignore — storeConfigDoc validator', () => {
  test('valid pattern body is persisted to <projectDir>/.okignore via atomic write', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');
    doc.getText('source').insert(0, 'drafts/\n*.draft.md\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    const path = configDocAbsPath(CONFIG_DOC_NAME_OKIGNORE, fx.ctx);
    expect(readFileSync(path, 'utf-8')).toBe('drafts/\n*.draft.md\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe('drafts/\n*.draft.md\n');
    expect(fx.rejections).toHaveLength(0);

    const entries = readdirSafe(fx.projectDir);
    expect(entries.filter((e) => e.includes('.tmp.'))).toHaveLength(0);
    expect(entries).toContain('.okignore');
  });

  test('comments + blank lines round-trip byte-identically', async () => {
    const body = '# header comment\n\ndrafts/\n\n# another\n*.tmp\n';
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');
    doc.getText('source').insert(0, body);

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    expect(readFileSync(join(fx.projectDir, '.okignore'), 'utf-8')).toBe(body);
  });

  test('whitespace-only line is rejected with OKIGNORE_INVALID + 1-indexed lineNumber', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, 'drafts/\n');
    doc.getText('source').insert(0, 'drafts/\n   \n*.tmp\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('reverted');
    expect(doc.getText('source').toString()).toBe('drafts/\n');
    expect(fx.rejections).toHaveLength(1);
    const r = fx.rejections[0];
    expect(r).toBeDefined();
    if (!r || !isKnownConfigError(r.error)) throw new Error('expected known error');
    expect(r.docName).toBe(CONFIG_DOC_NAME_OKIGNORE);
    expect(r.error.code).toBe('OKIGNORE_INVALID');
    if (r.error.code === 'OKIGNORE_INVALID') {
      expect(r.error.lineNumber).toBe(2);
    }
    expect(existsSync(join(fx.projectDir, '.okignore'))).toBe(false);
  });

  test('truly empty line ("" between newlines) is accepted (round-tripped blank metadata)', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');
    doc.getText('source').insert(0, 'a\n\nb\n\nc\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    expect(readFileSync(join(fx.projectDir, '.okignore'), 'utf-8')).toBe('a\n\nb\n\nc\n');
  });

  test('rejection with no prior LKG falls back to empty string (matches Settings empty-state)', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, '   \n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('reverted');
    expect(doc.getText('source').toString()).toBe('');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe('');
    expect(fx.rejections).toHaveLength(1);
  });

  test('back-to-back: invalid mutation reverts; subsequent valid mutation persists', async () => {
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, 'drafts/\n');
    const doc = new Y.Doc();

    doc.getText('source').insert(0, 'drafts/\n   \n');
    const r1 = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);
    expect(r1).toBe('reverted');
    expect(doc.getText('source').toString()).toBe('drafts/\n');

    doc.transact(() => {
      const t = doc.getText('source');
      t.delete(0, t.length);
      t.insert(0, 'drafts/\n*.tmp\n');
    });
    const r2 = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);
    expect(r2).toBe('persisted');
    expect(readFileSync(join(fx.projectDir, '.okignore'), 'utf-8')).toBe('drafts/\n*.tmp\n');
  });

  test('content equals LKG → no-op (no spurious rewrite)', async () => {
    const body = 'drafts/\n*.tmp\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, body);
    const doc = new Y.Doc();
    doc.getText('source').insert(0, body);

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(existsSync(join(fx.projectDir, '.okignore'))).toBe(false);
  });

  test('empty Y.Text with empty-string LKG (okignore cold-start floor) → no-op', async () => {
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');
    const doc = new Y.Doc();

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(existsSync(join(fx.projectDir, '.okignore'))).toBe(false);
  });

  test('empty Y.Text with non-empty LKG → persists empty body to disk + clears LKG (remove-last-pattern)', async () => {
    const initial = '/foo.md\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, initial);
    const path = configDocAbsPath(CONFIG_DOC_NAME_OKIGNORE, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, initial, 'utf-8');

    const doc = new Y.Doc();

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    expect(readFileSync(path, 'utf-8')).toBe('');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe('');
    expect(fx.rejections).toHaveLength(0);
  });

  test('revert transaction uses CONFIG_VALIDATION_REVERT_ORIGIN', async () => {
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, 'drafts/\n');
    const doc = new Y.Doc();
    doc.getText('source').insert(0, '   \n');

    const observedOrigins: unknown[] = [];
    doc.on('afterTransaction', (tx) => {
      observedOrigins.push(tx.origin);
    });

    await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(observedOrigins.some((o) => o === CONFIG_VALIDATION_REVERT_ORIGIN)).toBe(true);
  });

  test('persists to <contentDir>/.okignore when contentDir differs from projectDir', async () => {
    const contentDir = join(fx.projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const ctx: ConfigPersistenceCtx = { ...fx.ctx, contentDir };
    const doc = new Y.Doc();
    ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');
    doc.getText('source').insert(0, 'drafts/\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, ctx);

    expect(outcome).toBe('persisted');
    expect(readFileSync(join(contentDir, '.okignore'), 'utf-8')).toBe('drafts/\n');
    expect(existsSync(join(fx.projectDir, '.okignore'))).toBe(false);
  });
});

describe('okignore — applyExternalConfigChange', () => {
  test('valid external content updates Y.Text under CONFIG_FILE_WATCHER_ORIGIN', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');

    let observedOrigin: unknown = null;
    doc.on('afterTransaction', (tx) => {
      observedOrigin = tx.origin;
    });

    const newContent = 'drafts/\n*.tmp\n';
    const outcome = await applyExternalConfigChange(
      doc,
      CONFIG_DOC_NAME_OKIGNORE,
      newContent,
      fx.ctx,
    );

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(newContent);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe(newContent);
    expect(observedOrigin).toBe(CONFIG_FILE_WATCHER_ORIGIN);
    expect(fx.rejections).toHaveLength(0);
  });

  test('invalid external content (whitespace-only line) → rejected; Y.Text NOT mutated', async () => {
    const doc = new Y.Doc();
    const valid = 'drafts/\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, valid);
    doc.getText('source').insert(0, valid);

    const broken = 'drafts/\n   \n';
    const outcome = await applyExternalConfigChange(doc, CONFIG_DOC_NAME_OKIGNORE, broken, fx.ctx);

    expect(outcome).toBe('rejected');
    expect(doc.getText('source').toString()).toBe(valid);
    expect(fx.rejections).toHaveLength(1);
    const error = fx.rejections[0]?.error;
    expect(error).toBeDefined();
    if (error && isKnownConfigError(error) && error.code === 'OKIGNORE_INVALID') {
      expect(error.lineNumber).toBe(2);
    } else {
      throw new Error('expected OKIGNORE_INVALID error');
    }
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe(valid);
  });

  test('content equal to LKG short-circuits: no rejection, no Y.Text mutation', async () => {
    const doc = new Y.Doc();
    const body = 'drafts/\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, body);
    doc.getText('source').insert(0, body);

    let mutationCount = 0;
    doc.on('afterTransaction', (tx) => {
      if (tx.origin === CONFIG_FILE_WATCHER_ORIGIN) mutationCount++;
    });

    const outcome = await applyExternalConfigChange(doc, CONFIG_DOC_NAME_OKIGNORE, body, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(mutationCount).toBe(0);
    expect(fx.rejections).toHaveLength(0);
  });
});

describe('okignore — rejection counter telemetry', () => {
  let metricExporter: import('@opentelemetry/sdk-metrics').InMemoryMetricExporter;
  let meterProvider: import('@opentelemetry/sdk-metrics').MeterProvider;
  let metricReader: import('@opentelemetry/sdk-metrics').PeriodicExportingMetricReader;

  beforeEach(async () => {
    const sdk = await import('@opentelemetry/sdk-metrics');
    const api = await import('@opentelemetry/api');
    metricExporter = new sdk.InMemoryMetricExporter(sdk.AggregationTemporality.CUMULATIVE);
    metricReader = new sdk.PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000,
    });
    meterProvider = new sdk.MeterProvider({ readers: [metricReader] });
    api.metrics.setGlobalMeterProvider(meterProvider);
    __resetOkignoreTelemetryForTests();
  });

  afterEach(async () => {
    const api = await import('@opentelemetry/api');
    await meterProvider.shutdown();
    api.metrics.disable();
    __resetOkignoreTelemetryForTests();
  });

  async function readPoints(
    name: string,
  ): Promise<Array<{ attributes: Record<string, unknown>; value: number }>> {
    await metricReader.forceFlush();
    const out: Array<{ attributes: Record<string, unknown>; value: number }> = [];
    for (const rm of metricExporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const metric of sm.metrics) {
          if (metric.descriptor.name !== name) continue;
          for (const dp of metric.dataPoints) {
            out.push({ attributes: dp.attributes, value: dp.value as number });
          }
        }
      }
    }
    return out;
  }

  test('rejection from storeConfigDoc increments ok.config.ignore.rejection_total with bounded error.code label', async () => {
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');
    const doc = new Y.Doc();
    doc.getText('source').insert(0, '   \n');

    await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    const points = await readPoints('ok.config.ignore.rejection_total');
    const total = points.reduce((acc, p) => acc + p.value, 0);
    expect(total).toBe(1);
    for (const p of points) {
      expect(Object.keys(p.attributes).sort()).toEqual(['error.code']);
      expect(p.attributes['error.code']).toBe('OKIGNORE_INVALID');
    }
  });

  test('rejection from applyExternalConfigChange also increments the counter', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, 'drafts/\n');

    await applyExternalConfigChange(doc, CONFIG_DOC_NAME_OKIGNORE, '   \n', fx.ctx);

    const points = await readPoints('ok.config.ignore.rejection_total');
    const total = points.reduce((acc, p) => acc + p.value, 0);
    expect(total).toBe(1);
  });

  test('YAML config rejection does NOT increment the okignore counter', async () => {
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: true\n');
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'broken: [yaml\n');

    await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    const points = await readPoints('ok.config.ignore.rejection_total');
    const total = points.reduce((acc, p) => acc + p.value, 0);
    expect(total).toBe(0);
  });
});
