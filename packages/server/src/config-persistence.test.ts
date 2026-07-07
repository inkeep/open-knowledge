import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  loadConfigDoc,
  storeConfigDoc,
} from './config-persistence.ts';

interface Fixture {
  projectDir: string;
  homedir: string;
  rejections: Array<{ docName: string; error: ConfigValidationError }>;
  ctx: ConfigPersistenceCtx;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ok-config-persist-'));
  const projectDir = join(root, 'project');
  const homedir = join(root, 'home');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homedir, { recursive: true });
  const rejections: Fixture['rejections'] = [];
  const ctx: ConfigPersistenceCtx = {
    projectDir,
    lkgCache: new Map(),
    homedirOverride: homedir,
    onConfigRejected: (docName, error) => {
      rejections.push({ docName, error });
    },
  };
  return {
    projectDir,
    homedir,
    rejections,
    ctx,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
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
});

afterEach(() => {
  fx.cleanup();
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
    // Defaults should round-trip through ConfigSchema — `content.dir: .`
    // is the documented default for the project content root.
    expect(lkg).toContain('content:');
    expect(lkg).toContain('dir: .');
  });

  test('broken YAML on disk → seeds Y.Text with raw bytes + LKG = defaults', () => {
    const broken = 'mcp:\n  autoStart: !!!!!\n';
    writeWorkspaceConfig(fx.projectDir, broken);
    const doc = new Y.Doc();

    loadConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, fx.ctx);

    // Y.Text gets the raw bytes — the load surfaces what's actually on
    // disk; the L3 hook surfaces the rejection on first store.
    expect(doc.getText('source').toString()).toBe(broken);
    // LKG falls back to defaults so the revert path has a valid floor.
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
  // These tests model the "two OK windows open from different projects, one
  // toggles theme, the other toggles editor mode" race. Each window has its
  // own server with its own Y.Doc + LKG cache, but they share `~/.ok/global.yml`
  // on disk. Without serialization, the slower writer's stale Y.Text clobbers
  // the faster writer's already-persisted change.

  function makeSecondCtxSharingHomedir(primary: Fixture): {
    ctx: ConfigPersistenceCtx;
    rejections: Array<{ docName: string; error: ConfigValidationError }>;
  } {
    const rejections: Array<{ docName: string; error: ConfigValidationError }> = [];
    return {
      rejections,
      ctx: {
        projectDir: primary.projectDir, // same project dir, but the doc under test is the user-scoped one
        lkgCache: new Map(),
        homedirOverride: primary.homedir,
        onConfigRejected: (docName, error) => {
          rejections.push({ docName, error });
        },
      },
    };
  }

  test('reconciles when disk diverged from LKG: imports disk into Y.Text and does NOT overwrite disk', async () => {
    // Pre-state: disk holds "vA" from another writer that landed since our
    // LKG was set to "v0". Our Y.Text is "vB" — what the local user just toggled.
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: false\n', 'utf-8'); // "vA"
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n'); // "v0"

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n'); // "vB"

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx);

    expect(outcome).toBe('reconciled');
    // Disk preserved (the other writer's "vA" stands).
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
    // Our Y.Text imported disk content — local "vB" change is dropped.
    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    // LKG advances to current disk so the next store doesn't re-reconcile.
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe('mcp:\n  autoStart: false\n');
    expect(fx.rejections).toHaveLength(0);
  });

  test('two servers writing the SAME shared file: second store reconciles, first writer wins', async () => {
    // Two ctx fixtures backed by the same homedir → same `~/.ok/global.yml`
    // path. Models two OK windows from different projects.
    const second = makeSecondCtxSharingHomedir(fx);
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    expect(configDocAbsPath(CONFIG_DOC_NAME_USER, second.ctx)).toBe(path);

    // Initial shared state: disk = "v0", both LKGs = "v0".
    const v0 = 'mcp:\n  autoStart: true\n';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, v0, 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, v0);
    second.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, v0);

    // Window A toggles → its Y.Text = "vA"; stores; lands.
    const docA = new Y.Doc();
    docA.getText('source').insert(0, 'mcp:\n  autoStart: false\n');
    const outcomeA = await storeConfigDoc(docA, CONFIG_DOC_NAME_USER, undefined, fx.ctx);
    expect(outcomeA).toBe('persisted');
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');

    // Window B toggles a *different* key without having seen A's write —
    // its LKG is still "v0", its Y.Text is built on top of "v0". This is
    // the cross-key clobber scenario.
    const docB = new Y.Doc();
    docB.getText('source').insert(0, 'appearance:\n  theme: dark\n');
    const outcomeB = await storeConfigDoc(docB, CONFIG_DOC_NAME_USER, undefined, second.ctx);

    // Reconciliation: B detects disk ("vA") diverged from its LKG ("v0"),
    // imports disk into its Y.Text, and does not overwrite the file.
    expect(outcomeB).toBe('reconciled');
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n'); // A's write survives
    expect(docB.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');
    expect(second.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe('mcp:\n  autoStart: false\n');

    // Trade-off: B's local user toggle is dropped. Documented as the
    // expected UX — the slower writer must re-apply if they meant it.
    expect(docB.getText('source').toString()).not.toContain('theme: dark');
  });

  test('disk matches LKG: writes proceed normally (no spurious reconciliation)', async () => {
    // The negative case — same path, same context, no other writer. The
    // lock fires, the disk-vs-LKG check passes, and we land a normal write.
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'mcp:\n  autoStart: false\n');

    // Seed disk + LKG to identical "v0".
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

  test('disk diverged but content is INVALID YAML: do NOT reconcile, write our valid content instead', async () => {
    // Importing disk into Y.Text without validation
    // poisons LKG and creates a stuck revert loop on the next mutation.
    // Verify that when disk diverges from LKG but holds invalid bytes, we
    // fall through to write our (already-validated) content rather than
    // reconcile.
    const path = configDocAbsPath(CONFIG_DOC_NAME_USER, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    // Write malformed YAML to disk — would crash any consumer that parses it.
    writeFileSync(path, 'mcp:\n  autoStart: !!!!!!!!!!!!!!\n', 'utf-8');
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_USER, 'mcp:\n  autoStart: true\n');

    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_USER, undefined, fx.ctx);

    // Outcome is 'persisted', NOT 'reconciled' — we declined to import
    // broken disk content and wrote our valid content instead.
    expect(outcome).toBe('persisted');
    expect(readFileSync(path, 'utf-8')).toBe('appearance:\n  theme: dark\n');
    expect(doc.getText('source').toString()).toBe('appearance:\n  theme: dark\n');
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe('appearance:\n  theme: dark\n');
    expect(fx.rejections).toHaveLength(0);
  });

  test('mkdir failure surfaces as write-failed via onConfigRejected; no exception escapes', async () => {
    // tracedMkdir / withFileLock exceptions would
    // propagate uncaught into Hocuspocus's onStoreDocument. Pre-create the
    // parent path AS A FILE so tracedMkdir hits ENOTDIR; confirm we surface
    // 'write-failed' rather than throwing.
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
    // The previous catch-all swallowed EACCES /
    // EIO / EMFILE alongside ENOENT, silently re-enabling the cross-window
    // clobber this PR fixes. Pin the new narrow-catch behavior: a non-ENOENT
    // read error returns 'write-failed' rather than falling through.
    //
    // Setup: pre-create the config file as a DIRECTORY so readFileSync
    // throws EISDIR (a non-ENOENT errno). This is platform-portable —
    // EISDIR is the same on macOS / Linux / Windows for "tried to read a
    // directory as a file".
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

    // Pre-create absPath as a directory so the rename in atomic write fails
    // with EISDIR. Validation passes (content is well-formed); only the
    // disk write step throws.
    const absPath = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    mkdirSync(absPath, { recursive: true });

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('write-failed');
    expect(fx.rejections).toHaveLength(1);
    expect(fx.rejections[0]?.docName).toBe(CONFIG_DOC_NAME_PROJECT);
    expect(fx.rejections[0]?.error.code).toBe('WRITE_ERROR');

    // LKG was NOT updated — next mutation will retry.
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBeUndefined();

    // Y.Text retains the user's edit; content was valid, only the write failed.
    expect(doc.getText('source').toString()).toBe('mcp:\n  autoStart: false\n');

    // No leftover .tmp.* files in the parent directory — best-effort cleanup
    // ran when the rename threw.
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
    // Y.Text is empty by construction.
    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(existsSync(join(fx.projectDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('YAML doc: empty Y.Text with non-empty LKG → no-op (YAML scope preserved)', async () => {
    // Pins that the okignore-specific guard change does NOT alter
    // YAML persistence semantics. The empty-body short-circuit is gated
    // to the okignore arm via `documentName === CONFIG_DOC_NAME_OKIGNORE`,
    // so YAML with non-empty LKG + empty Y.Text continues to no-op
    // regardless of LKG state. A future change that removes the okignore
    // carve-out would silently expand YAML scope; this test catches that.
    const yaml = 'mcp:\n  autoStart: true\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, yaml);
    writeWorkspaceConfig(fx.projectDir, yaml);
    const doc = new Y.Doc();
    // Y.Text is empty by construction — models the user clearing the YAML body.

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
    // Disk content is unchanged from the pre-seeded value (no write occurred).
    expect(readFileSync(configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx), 'utf-8')).toBe(yaml);
    // LKG is unchanged.
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
    // Disk file unchanged (it never existed in this test).
    expect(existsSync(join(fx.projectDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('schema-invalid → reverts Y.Text + structured SCHEMA_INVALID error with issues', async () => {
    const lkgYaml = 'content:\n  dir: docs\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, lkgYaml);
    const doc = new Y.Doc();
    // appearance.theme is an enum; non-member value fails safeParse.
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
    // No LKG seeded. Y.Text has bad content. The hook reverts to defaults.
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'appearance:\n  theme: midnight\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);

    expect(outcome).toBe('reverted');
    const reverted = doc.getText('source').toString();
    expect(reverted).toContain('content:');
    expect(reverted).toContain('dir: .');
    // LKG was missing; revert seeded it with defaults so subsequent rejections have a floor.
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

    // Round 1: invalid → revert
    doc.getText('source').insert(0, 'foo: [bar: [baz\n');
    const r1 = await storeConfigDoc(doc, CONFIG_DOC_NAME_PROJECT, undefined, fx.ctx);
    expect(r1).toBe('reverted');

    // Round 2: caller (e.g., re-typed input) writes a valid YAML.
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
    // Lazy-imported to avoid pulling persistence.ts deps into the unit tests above.
    const { createPersistenceExtension } = await import('./persistence.ts');
    const yaml = 'mcp:\n  autoStart: false\n';
    writeWorkspaceConfig(fx.projectDir, yaml);
    const rejections: Array<{ docName: string; error: ConfigValidationError }> = [];

    const handle = createPersistenceExtension({
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigRejected: (docName, error) => rejections.push({ docName, error }),
    });

    const document = new Y.Doc();
    // Hocuspocus's onLoadDocument receives a Hocuspocus-flavored payload; we
    // pass a minimal subset matching the type the implementation reads.
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
    // The persist already succeeded by the time onConfigPersisted fires — a
    // throwing consumer-notify callback must not propagate into Hocuspocus's
    // onStoreDocument lifecycle (it would misreport a durable write as a
    // store failure).
    const { createPersistenceExtension } = await import('./persistence.ts');
    const notified: string[] = [];

    const handle = createPersistenceExtension({
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

    // The await resolving IS the assertion that no exception escapes the hook.
    await handle.extension.onStoreDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      lastTransactionOrigin: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);

    // The callback DID fire with the right docName — the isolation assertion
    // above can't pass vacuously via a never-invoked callback.
    expect(notified).toEqual([CONFIG_DOC_NAME_PROJECT]);
    // And the persist itself succeeded: config content landed on disk.
    const path = configDocAbsPath(CONFIG_DOC_NAME_PROJECT, fx.ctx);
    expect(readFileSync(path, 'utf-8')).toBe('mcp:\n  autoStart: false\n');
  });

  test('onConfigPersisted fires only on durable outcomes — a no-op store does not notify', async () => {
    // The callback's contract is "a validated config value just reached durable
    // state". A store whose content matches LKG returns 'no-op' without
    // touching disk; notifying consumers there would widen the contract to
    // "every store attempt" (spurious re-applies + log noise).
    const { createPersistenceExtension } = await import('./persistence.ts');
    const notified: string[] = [];

    const handle = createPersistenceExtension({
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

    // First store: durable write ('persisted') — notifies once and sets LKG.
    await handle.extension.onStoreDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      lastTransactionOrigin: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);
    expect(notified).toEqual([CONFIG_DOC_NAME_PROJECT]);

    // Second store with unchanged content: LKG equality short-circuits to
    // 'no-op' — consumers must NOT be re-notified.
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
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigRejected: (docName, error) => rejections.push({ docName, error }),
    });

    const document = new Y.Doc();

    // Seed LKG via load (read missing file → defaults LKG).
    await handle.extension.onLoadDocument?.({
      document,
      documentName: CONFIG_DOC_NAME_PROJECT,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
    } as any);

    // Now write invalid content.
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
      contentDir: fx.projectDir,
      projectDir: fx.projectDir,
      gitEnabled: false,
      configHomedirOverride: fx.homedir,
      onConfigRejected: (docName, error) => rejections.push({ docName, error }),
    });

    const document = new Y.Doc();
    // Non-config, non-system doc: regular markdown path. We don't actually
    // exercise it (would require setting up the markdown manager); just
    // ensure the config-rejection callback never fires for it.
    document.getText('source').insert(0, 'this is not yaml: but: malformed: [');

    // The store hook for a regular doc would normally serialize markdown,
    // but here we only assert that onConfigRejected wasn't fired for a
    // non-config doc name — the dispatcher gates on `isConfigDoc`.
    try {
      await handle.extension.onStoreDocument?.({
        document,
        documentName: 'notes/intro',
        lastTransactionOrigin: undefined,
        // biome-ignore lint/suspicious/noExplicitAny: minimal Hocuspocus shim
      } as any);
    } catch {
      // Markdown path may throw on the malformed-YAML XmlFragment; we don't
      // care — we only assert the config rejection callback did NOT fire.
    }

    expect(rejections).toHaveLength(0);
  });
});

// Helper used by the atomic-write test.
function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

describe('applyExternalConfigChange', () => {
  test('valid external content updates Y.Text under CONFIG_FILE_WATCHER_ORIGIN + LKG', () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'theme: light\n');
    doc.getText('source').insert(0, 'theme: light\n');

    let observedOrigin: unknown = null;
    doc.on('afterTransaction', (tx) => {
      // Capture the LAST mutating origin so we observe the one from
      // applyExternalConfigChange, not the prior insert.
      observedOrigin = tx.origin;
    });

    const newContent = 'theme: dark\n';
    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, newContent, fx.ctx);

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(newContent);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT)).toBe(newContent);
    expect(observedOrigin).toBe(CONFIG_FILE_WATCHER_ORIGIN);
    expect(fx.rejections).toHaveLength(0);
  });

  test('content equal to LKG short-circuits: no mutation, no rejection', () => {
    const doc = new Y.Doc();
    const yaml = 'mcp:\n  autoStart: false\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, yaml);
    doc.getText('source').insert(0, yaml);

    let mutationCount = 0;
    doc.on('afterTransaction', (tx) => {
      // Filter out the seed insert we just did (origin === null).
      if (tx.origin === CONFIG_FILE_WATCHER_ORIGIN) mutationCount++;
    });

    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, yaml, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(mutationCount).toBe(0);
    expect(fx.rejections).toHaveLength(0);
  });

  test('null document → no-op (document not loaded yet)', () => {
    const outcome = applyExternalConfigChange(
      null,
      CONFIG_DOC_NAME_PROJECT,
      'theme: dark\n',
      fx.ctx,
    );
    expect(outcome).toBe('no-op');
    expect(fx.rejections).toHaveLength(0);
  });

  test('YAML parse error → rejected; Y.Text NOT mutated; onConfigRejected fired', () => {
    const doc = new Y.Doc();
    const valid = 'theme: light\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, valid);
    doc.getText('source').insert(0, valid);

    const broken = 'theme: !!!!!\n';
    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, broken, fx.ctx);

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

  test('schema-invalid external content → rejected with structured issues', () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'content:\n  dir: docs\n');

    const invalid = 'appearance:\n  theme: midnight\n';
    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, invalid, fx.ctx);

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

  test('LKG-undefined + valid external content → applied; LKG seeded', () => {
    const doc = new Y.Doc();
    // No LKG entry yet — simulates first watcher fire after lazy first-write
    // before any L1/L2/L3 update.
    expect(fx.ctx.lkgCache.has(CONFIG_DOC_NAME_USER)).toBe(false);

    const yaml = 'theme: dark\n';
    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_USER, yaml, fx.ctx);

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(yaml);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_USER)).toBe(yaml);
  });

  test('project-local: external content propagates to Y.Text + LKG', () => {
    const doc = new Y.Doc();
    expect(fx.ctx.lkgCache.has(CONFIG_DOC_NAME_PROJECT_LOCAL)).toBe(false);

    const yaml = 'autoSync:\n  enabled: true\n';
    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT_LOCAL, yaml, fx.ctx);

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(yaml);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_PROJECT_LOCAL)).toBe(yaml);
  });

  test('Y.Text mutation under CONFIG_FILE_WATCHER_ORIGIN does NOT trigger storeConfigDoc', async () => {
    // The skipStoreHooks flag on the origin is what prevents the
    // persistence-hook from re-writing disk. Storing a doc whose last
    // transaction origin is CONFIG_FILE_WATCHER_ORIGIN must be a no-op.
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'theme: light\n');
    doc.getText('source').insert(0, 'theme: light\n');

    applyExternalConfigChange(doc, CONFIG_DOC_NAME_PROJECT, 'theme: dark\n', fx.ctx);

    // Now invoke storeConfigDoc with the file-watcher origin — it must not
    // entry-gate (we reserved that for REVERT origin), but the LKG-equality
    // short-circuit should fire because applyExternalConfigChange just
    // updated LKG to match Y.Text content.
    const outcome = await storeConfigDoc(
      doc,
      CONFIG_DOC_NAME_PROJECT,
      CONFIG_FILE_WATCHER_ORIGIN,
      fx.ctx,
    );
    expect(outcome).toBe('no-op');
    // No file written for the watcher-driven path.
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
    // The validator rejects a single whitespace-only line. The load path
    // surfaces what's on disk into Y.Text so a UI can display + repair it,
    // but LKG falls back to empty string so the next mutation has a valid
    // floor to revert to.
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
    // Three patterns separated by blank lines — empty lines are valid.
    doc.getText('source').insert(0, 'a\n\nb\n\nc\n');

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('persisted');
    expect(readFileSync(join(fx.projectDir, '.okignore'), 'utf-8')).toBe('a\n\nb\n\nc\n');
  });

  test('rejection with no prior LKG falls back to empty string (matches Settings empty-state)', async () => {
    // No LKG seeded — simulates first commit before any successful validation.
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
    // `defaultLkgFor(CONFIG_DOC_NAME_OKIGNORE)` returns '' as the cold-start
    // floor that `loadConfigDoc` installs when no validly-persisted disk
    // state exists (disk missing, empty, or invalid — e.g. whitespace-only
    // contents). The guard's `lkg === ''` arm short-circuits
    // this case so a fresh project never gets a spurious 0-byte .okignore on
    // first boot. Note: the downstream LKG-equality guard (`content === lkg`)
    // would also catch this case ('' === ''); the `lkg === ''` arm is
    // belt-and-suspenders for intent clarity, not an independently load-bearing
    // guard.
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');
    const doc = new Y.Doc();
    // Y.Text is empty by construction.

    const outcome = await storeConfigDoc(doc, CONFIG_DOC_NAME_OKIGNORE, undefined, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(existsSync(join(fx.projectDir, '.okignore'))).toBe(false);
  });

  test('empty Y.Text with non-empty LKG → persists empty body to disk + clears LKG (remove-last-pattern)', async () => {
    // User right-clicked a file and "Hide this file" wrote /foo.md → LKG and
    // disk both hold /foo.md. The user then opens Settings → Ignore patterns
    // and removes the last row, emptying the okignore Y.Text body.
    // validateOkignore('') returns ok, so the persistence hook MUST write
    // empty bytes to disk and advance LKG to ''. The disk change is what
    // fires chokidar → ContentFilter rebuild → CC1 'files' → FileTree
    // refetch. Returning 'no-op' silently drops the user's removal: file
    // stays hidden, and the next page load re-seeds Y.Text from the stale
    // disk file so the removed pattern reappears in Settings.
    const initial = '/foo.md\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, initial);
    const path = configDocAbsPath(CONFIG_DOC_NAME_OKIGNORE, fx.ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, initial, 'utf-8');

    const doc = new Y.Doc();
    // Y.Text is empty by construction — models the user clearing the body.

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
  test('valid external content updates Y.Text under CONFIG_FILE_WATCHER_ORIGIN', () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, '');

    let observedOrigin: unknown = null;
    doc.on('afterTransaction', (tx) => {
      observedOrigin = tx.origin;
    });

    const newContent = 'drafts/\n*.tmp\n';
    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_OKIGNORE, newContent, fx.ctx);

    expect(outcome).toBe('applied');
    expect(doc.getText('source').toString()).toBe(newContent);
    expect(fx.ctx.lkgCache.get(CONFIG_DOC_NAME_OKIGNORE)).toBe(newContent);
    expect(observedOrigin).toBe(CONFIG_FILE_WATCHER_ORIGIN);
    expect(fx.rejections).toHaveLength(0);
  });

  test('invalid external content (whitespace-only line) → rejected; Y.Text NOT mutated', () => {
    const doc = new Y.Doc();
    const valid = 'drafts/\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, valid);
    doc.getText('source').insert(0, valid);

    const broken = 'drafts/\n   \n';
    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_OKIGNORE, broken, fx.ctx);

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

  test('content equal to LKG short-circuits: no rejection, no Y.Text mutation', () => {
    const doc = new Y.Doc();
    const body = 'drafts/\n';
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, body);
    doc.getText('source').insert(0, body);

    let mutationCount = 0;
    doc.on('afterTransaction', (tx) => {
      if (tx.origin === CONFIG_FILE_WATCHER_ORIGIN) mutationCount++;
    });

    const outcome = applyExternalConfigChange(doc, CONFIG_DOC_NAME_OKIGNORE, body, fx.ctx);

    expect(outcome).toBe('no-op');
    expect(mutationCount).toBe(0);
    expect(fx.rejections).toHaveLength(0);
  });
});

describe('okignore — rejection counter telemetry', () => {
  // OTel harness: bind an InMemoryMetricExporter so we can read counter
  // points after rejections fire. Mirrors `frontmatter-telemetry.test.ts`.
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
      // Bounded-cardinality discipline: the only label is `error.code`.
      expect(Object.keys(p.attributes).sort()).toEqual(['error.code']);
      expect(p.attributes['error.code']).toBe('OKIGNORE_INVALID');
    }
  });

  test('rejection from applyExternalConfigChange also increments the counter', async () => {
    const doc = new Y.Doc();
    fx.ctx.lkgCache.set(CONFIG_DOC_NAME_OKIGNORE, 'drafts/\n');

    applyExternalConfigChange(doc, CONFIG_DOC_NAME_OKIGNORE, '   \n', fx.ctx);

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
