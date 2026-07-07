import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkTargetExists, computeShareTargetMissing } from './check-target-exists.ts';

describe('checkTargetExists', () => {
  function makeProject(): string {
    return mkdtempSync(join(tmpdir(), 'ok-check-target-exists-'));
  }

  function cleanup(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }

  describe('doc kind', () => {
    test('returns exists for a regular file at a simple path', () => {
      const project = makeProject();
      try {
        writeFileSync(join(project, 'README.md'), '# hi\n');
        expect(checkTargetExists(project, 'doc', 'README.md')).toEqual('exists');
      } finally {
        cleanup(project);
      }
    });

    test('returns exists for a nested file via slashed path', () => {
      const project = makeProject();
      try {
        mkdirSync(join(project, 'docs', 'guides'), { recursive: true });
        writeFileSync(join(project, 'docs', 'guides', 'intro.md'), 'body\n');
        expect(checkTargetExists(project, 'doc', 'docs/guides/intro.md')).toEqual('exists');
      } finally {
        cleanup(project);
      }
    });

    test('returns missing when the file does not exist (ENOENT)', () => {
      const project = makeProject();
      try {
        // Project exists, file does not — typical stale-branch scenario.
        expect(checkTargetExists(project, 'doc', 'README.md')).toEqual('missing');
      } finally {
        cleanup(project);
      }
    });

    test('returns missing when a doc path resolves to a directory', () => {
      // Stat-succeeds-but-not-a-file is treated as missing — a directory is not
      // a markdown doc and silent-dispatch would still produce a blank editor.
      const project = makeProject();
      try {
        mkdirSync(join(project, 'docs'), { recursive: true });
        expect(checkTargetExists(project, 'doc', 'docs')).toEqual('missing');
      } finally {
        cleanup(project);
      }
    });

    test('follows symlinks to a real file (returns exists)', () => {
      // Symlinks inside contentDir are a supported topology per the OK
      // symlink contract; the probe should classify the link's target,
      // not the link itself.
      const project = makeProject();
      try {
        writeFileSync(join(project, 'real.md'), '# real\n');
        symlinkSync(join(project, 'real.md'), join(project, 'link.md'));
        expect(checkTargetExists(project, 'doc', 'link.md')).toEqual('exists');
      } finally {
        cleanup(project);
      }
    });
  });

  describe('folder kind', () => {
    test('returns exists for a directory at a simple path', () => {
      const project = makeProject();
      try {
        mkdirSync(join(project, 'docs'), { recursive: true });
        expect(checkTargetExists(project, 'folder', 'docs')).toEqual('exists');
      } finally {
        cleanup(project);
      }
    });

    test('returns exists for a nested directory via slashed path', () => {
      const project = makeProject();
      try {
        mkdirSync(join(project, 'docs', 'guides'), { recursive: true });
        expect(checkTargetExists(project, 'folder', 'docs/guides')).toEqual('exists');
      } finally {
        cleanup(project);
      }
    });

    test('returns missing when the directory does not exist (ENOENT)', () => {
      const project = makeProject();
      try {
        expect(checkTargetExists(project, 'folder', 'docs')).toEqual('missing');
      } finally {
        cleanup(project);
      }
    });

    test('returns missing when a folder path resolves to a regular file', () => {
      // The kind-aware predicate inverts the doc case: a folder probe that
      // lands on a file is a genuine miss — the share's target directory
      // isn't present in the expected shape on this branch.
      const project = makeProject();
      try {
        writeFileSync(join(project, 'README.md'), '# hi\n');
        expect(checkTargetExists(project, 'folder', 'README.md')).toEqual('missing');
      } finally {
        cleanup(project);
      }
    });

    test('follows symlinks to a real directory (returns exists)', () => {
      const project = makeProject();
      try {
        mkdirSync(join(project, 'real-dir'), { recursive: true });
        symlinkSync(join(project, 'real-dir'), join(project, 'link-dir'));
        expect(checkTargetExists(project, 'folder', 'link-dir')).toEqual('exists');
      } finally {
        cleanup(project);
      }
    });
  });

  describe('path-shape gate (kind-agnostic)', () => {
    test('returns unreadable for non-absolute projectPath', () => {
      expect(checkTargetExists('relative/path', 'doc', 'README.md')).toEqual('unreadable');
    });

    test('returns unreadable for empty projectPath', () => {
      expect(checkTargetExists('', 'doc', 'README.md')).toEqual('unreadable');
    });

    test('returns unreadable for projectPath containing a NUL byte', () => {
      expect(checkTargetExists('/tmp/a\0b', 'doc', 'README.md')).toEqual('unreadable');
    });

    test('returns unreadable for projectPath that resolves to a different path (`..` escape)', () => {
      expect(checkTargetExists('/tmp/../etc', 'doc', 'passwd')).toEqual('unreadable');
    });

    test('returns unreadable for empty path (doc kind)', () => {
      const project = makeProject();
      try {
        expect(checkTargetExists(project, 'doc', '')).toEqual('unreadable');
      } finally {
        cleanup(project);
      }
    });

    test('returns unreadable for empty path (folder kind) — content-root is skipped upstream', () => {
      // The content-root folder share never reaches this function (the
      // receive-flow skips the probe for an empty path). Defense-in-depth:
      // an empty path is still rejected here rather than statting the
      // project root and reporting a misleading 'exists'.
      const project = makeProject();
      try {
        expect(checkTargetExists(project, 'folder', '')).toEqual('unreadable');
      } finally {
        cleanup(project);
      }
    });

    test('returns unreadable for absolute path', () => {
      const project = makeProject();
      try {
        // Even if the absolute path resolves inside the project, an absolute
        // input is rejected — the share encodes repo-relative paths and any
        // absolute input is a malformed payload.
        writeFileSync(join(project, 'README.md'), '# hi\n');
        expect(checkTargetExists(project, 'doc', join(project, 'README.md'))).toEqual('unreadable');
      } finally {
        cleanup(project);
      }
    });

    test('returns unreadable for path with a NUL byte', () => {
      const project = makeProject();
      try {
        expect(checkTargetExists(project, 'doc', 'a\0b.md')).toEqual('unreadable');
      } finally {
        cleanup(project);
      }
    });

    test('returns unreadable for path containing a `..` segment', () => {
      // Pre-resolve rejection of any `..` segment — even if the lexical join
      // would stay inside, we don't want to allow path traversal patterns
      // through. Caller MUST send a clean repo-relative path.
      const project = makeProject();
      try {
        writeFileSync(join(project, 'README.md'), '# hi\n');
        expect(checkTargetExists(project, 'doc', 'docs/../README.md')).toEqual('unreadable');
      } finally {
        cleanup(project);
      }
    });

    test('returns unreadable for path that escapes the project root (`../`)', () => {
      const project = makeProject();
      try {
        expect(checkTargetExists(project, 'doc', '../escape.md')).toEqual('unreadable');
      } finally {
        cleanup(project);
      }
    });

    test('does not confuse sibling-directory prefix matches with containment', () => {
      // `/tmp/foo` and `/tmp/foo-evil` share a string prefix but are not
      // nested; the trailing-separator guard inside `joinContained` must
      // distinguish them. The share's path would need to be a string
      // like `../foo-evil/file.md` to even reach this code path (the
      // `..`-pre-check rejects it) — this test pins the second-line defense.
      const parent = mkdtempSync(join(tmpdir(), 'ok-check-target-exists-parent-'));
      try {
        const project = join(parent, 'proj');
        const sibling = join(parent, 'proj-evil');
        mkdirSync(project);
        mkdirSync(sibling);
        writeFileSync(join(sibling, 'file.md'), 'no\n');
        // `..` in path is rejected by `isSafeTargetPath` — this case
        // exercises the containment-check fallback by going through
        // `joinContained` directly via the absolute-projectPath rejection
        // path. The trailing-separator guard prevents the silent
        // sibling-match shape.
        expect(checkTargetExists(project, 'doc', '../proj-evil/file.md')).toEqual('unreadable');
      } finally {
        cleanup(parent);
      }
    });
  });

  describe('graceful-fail (kind-agnostic)', () => {
    test('returns missing when projectPath itself does not exist', () => {
      // Probing inside a deleted project resolves to ENOENT, same as the
      // missing-file case. Treating these identically is correct: the
      // upstream listRecent → validateLocalFolder flow already gates on
      // project existence; if we reach `checkTargetExists` with a stale
      // path, the dialog still surfaces the right "not on this branch"
      // copy and the user can re-pick.
      expect(
        checkTargetExists('/tmp/definitely-does-not-exist-ok-test-12345/proj', 'doc', 'README.md'),
      ).toEqual('missing');
    });

    test('handles unreadable directory (EACCES) as unreadable, not missing', () => {
      // Non-ENOENT I/O errors collapse to 'unreadable' so the share-receive
      // flow falls back to silent dispatch — never block on a single
      // filesystem permission edge case. Skipped on platforms where chmod
      // 0 doesn't actually restrict access (Windows, root, some CI sandboxes).
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      const project = makeProject();
      try {
        mkdirSync(join(project, 'locked'), { recursive: true });
        writeFileSync(join(project, 'locked', 'file.md'), '# hi\n');
        chmodSync(join(project, 'locked'), 0o000);
        try {
          // EACCES on the parent directory propagates as a non-ENOENT stat
          // failure inside checkTargetExists.
          const result = checkTargetExists(project, 'doc', 'locked/file.md');
          // Either 'unreadable' (EACCES) or 'exists' (privileged test runner).
          // The miss signal MUST NOT surface here — that would route to the
          // "file not on this branch" dialog for a permissions edge case.
          expect(result).not.toEqual('missing');
        } finally {
          chmodSync(join(project, 'locked'), 0o755);
        }
      } finally {
        cleanup(project);
      }
    });
  });
});

describe('computeShareTargetMissing', () => {
  function makeProject(): string {
    return mkdtempSync(join(tmpdir(), 'ok-compute-target-missing-'));
  }

  function cleanup(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }

  // Real probe + real filesystem: the decision is exercised through the actual
  // `checkTargetExists` (no stub), so the mapping from probe result to the
  // caller's boolean is pinned end-to-end.
  test('flags a doc target that is absent on the working tree', () => {
    const project = makeProject();
    try {
      // Project exists, the shared doc does not — the receiver's branch is
      // behind, or the doc was deleted/renamed upstream after the share.
      expect(
        computeShareTargetMissing(checkTargetExists, project, {
          kind: 'doc',
          path: 'notes/plan.md',
        }),
      ).toBe(true);
    } finally {
      cleanup(project);
    }
  });

  test('does not flag a doc target present on the working tree', () => {
    const project = makeProject();
    try {
      mkdirSync(join(project, 'notes'), { recursive: true });
      writeFileSync(join(project, 'notes', 'plan.md'), '# plan\n');
      expect(
        computeShareTargetMissing(checkTargetExists, project, {
          kind: 'doc',
          path: 'notes/plan.md',
        }),
      ).toBe(false);
    } finally {
      cleanup(project);
    }
  });

  test('flags a folder target that is absent on the working tree', () => {
    const project = makeProject();
    try {
      expect(
        computeShareTargetMissing(checkTargetExists, project, { kind: 'folder', path: 'guides' }),
      ).toBe(true);
    } finally {
      cleanup(project);
    }
  });

  test('does not flag a folder target present on the working tree', () => {
    const project = makeProject();
    try {
      mkdirSync(join(project, 'guides'), { recursive: true });
      expect(
        computeShareTargetMissing(checkTargetExists, project, { kind: 'folder', path: 'guides' }),
      ).toBe(false);
    } finally {
      cleanup(project);
    }
  });

  test('never flags a content-root folder share (empty path)', () => {
    // The working-tree root is always present, and the probe rejects an empty
    // path as unreadable — either way the content root must dispatch normally.
    const project = makeProject();
    try {
      expect(
        computeShareTargetMissing(checkTargetExists, project, { kind: 'folder', path: '' }),
      ).toBe(false);
    } finally {
      cleanup(project);
    }
  });

  test('fails open (no flag) when the target path is unsafe', () => {
    // A traversal path resolves to `unreadable`, not `missing` — a probe that
    // refuses the input must never route the receiver to the miss panel.
    const project = makeProject();
    try {
      expect(
        computeShareTargetMissing(checkTargetExists, project, {
          kind: 'doc',
          path: '../escape.md',
        }),
      ).toBe(false);
    } finally {
      cleanup(project);
    }
  });

  test('fails open (no flag) when the project path is unsafe', () => {
    // A non-absolute project path is rejected as `unreadable`; the open proceeds
    // rather than surfacing a false miss.
    expect(
      computeShareTargetMissing(checkTargetExists, 'relative/project', {
        kind: 'doc',
        path: 'README.md',
      }),
    ).toBe(false);
  });
});
