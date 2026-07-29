/**
 * R13 patch verification — checks the installed y-prosemirror@1.3.7 AND
 * @tiptap/y-tiptap@3.0.3 actually have our patch body, not the upstream
 * destructive-delete behavior.
 *
 * ## Why this test exists
 *
 * The R13 patch is applied via pnpm's `patchedDependencies` at install time in two places
 * because two different `@tiptap/*` extensions import different packages:
 *   (a) `patches/y-prosemirror@1.3.7.patch` — `@tiptap/extension-collaboration-cursor`
 *       imports `yCursorPlugin` from this package.
 *   (b) `patches/@tiptap%2Fy-tiptap@3.0.3.patch` — `@tiptap/extension-collaboration`
 *       imports `ySyncPlugin` / `yUndoPlugin` from this vendored Tiptap fork;
 *       our 27+ direct imports of `updateYFragment` /
 *       `yXmlFragmentToProsemirrorJSON` also resolve here.
 *
 * Both packages contain their own bundled copies of the destructive-delete
 * catch blocks; patching only one leaves the other live in production.
 *
 * If either patch silently fails to apply (e.g., upstream drift, corrupted
 * lockfile, missing patchedDependencies entry), the destructive
 * `(el._item).delete(transaction)` path returns, which is catastrophic —
 * schema-throw silently destroys peer data across the CRDT.
 *
 * This test reads each installed bundle and asserts:
 *   1. The patch marker comment `R13 patch:` is present at both throw sites
 *   2. The destructive `(el._item).delete(transaction)` call is absent from
 *      those sites
 *   3. The `rawMdxFallback` substitution + `globalThis.__okYpsCounters` increments are present
 *   4. The `ymark:` mark-encoding helpers (`YMARK_PREFIX` / `splitYAttrs` /
 *      `equalYMarks`) survive, so ProseMirror marks on inline element/leaf
 *      nodes still cross the Y bridge
 *   5. The `patchedDependencies` entries are registered in pnpm-workspace.yaml
 *
 * If this test fails on a clean `pnpm install`, the fix is to investigate
 * the patch file (it may need re-porting to a new package version).
 *
 * End-to-end verification of the patch actually firing on a live Y.Doc
 * is covered by
 * `packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts`,
 * which drives a schema.node() throw through the production import path.
 *
 * ## Upgrade procedure (bumping either patched package)
 *
 * The patches are pinned to specific versions (`y-prosemirror@1.3.7`,
 * `@tiptap/y-tiptap@3.0.3`). Upstream may refactor the sync-plugin
 * internals. When bumping either package to version N.N.N, do the work in a
 * DEDICATED PR (do not bundle with unrelated changes):
 *
 *   1. **Diff upstream** — compare the old patched bundle against the new
 *      version. Focus on the two `catch (e) {` blocks inside
 *      `createNodeFromYElement` and `createTextNodesFromYText`. If upstream
 *      moved or replaced the destructive `(el._item).delete(transaction)` call,
 *      re-port to the new call sites. Patch invariants to preserve:
 *        - NO `(el._item).delete(transaction)` anywhere in the bundle
 *        - `rawMdxFallback` substitution in block-context `schema.node()` catch
 *        - `globalThis.__okYpsCounters.{block,inline}++` at every catch site
 *        - Structured `console.warn('[y-prosemirror] ...')` retained (the log
 *          prefix is a stable identifier tests/ops filter on — keep it even
 *          when the host package is `@tiptap/y-tiptap`)
 *        - The `ymark:`-prefixed reserved-attribute encoding (`YMARK_PREFIX` /
 *          `splitYAttrs` / `equalYMarks`) must be re-ported alongside the
 *          delete-fix — it is what keeps ProseMirror marks on inline
 *          element/leaf nodes alive across the Y bridge. `equalYMarks` depends
 *          on upstream `yattr2markname` to reverse hash-suffixed attribute
 *          keys back to mark names; do NOT replace it with direct key
 *          comparison or hash-suffixed mark lookup breaks.
 *        - EVERY artifact the `exports` map can serve must be re-ported, not
 *          just the default one. `y-prosemirror` serves `dist/y-prosemirror.cjs`
 *          to `require` and `src/plugins/sync-plugin.js` (via
 *          `src/y-prosemirror.js`) to `import`; the browser build takes the
 *          latter, so a `dist`-only re-port ships an unpatched editor.
 *
 *   2. **Regenerate via `pnpm patch`**:
 *        `pnpm patch <pkg>@N.N.N`
 *      edit EVERY file the package's `PATCHED_BUNDLES` entries below point at
 *      (that array is the authoritative list — do not infer the layout, since
 *      the ESM artifact is not always under `dist/`), then
 *      `pnpm patch-commit <dir>`. pnpm writes the patch file under `patches/`
 *      and updates `patchedDependencies` in `pnpm-workspace.yaml`.
 *
 *   3. **Update the `PATCHED_BUNDLES` array below** to reflect new paths if
 *      the bundle layout changed.
 *
 *   4. **Run the full gate**: `pnpm check` PLUS the live-fire regression
 *      at `packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts`.
 *
 * If upstream ever adds a non-destructive hook (e.g., `onSchemaError`
 * callback), retire the patches in favor of the official API. Track upstream
 * at https://github.com/yjs/y-prosemirror and https://github.com/ueberdosis/y-tiptap.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

function findRepoRoot(): string {
  // this file lives at packages/core/src/ — repo root is two dirs up from package.json
  return join(__dirname, '..', '..', '..');
}

const REPO_ROOT = findRepoRoot();

/**
 * The upstream destructive-delete call the R13 patch removes.
 *
 * Upstream does not write it as a bare `_item.delete(transaction)` — it casts
 * first, so the emitted source is `(el._item).delete(transaction)` with the
 * cast's closing paren sitting between `_item` and `.delete`. A matcher that
 * looks for the bare substring finds nothing in a fully stock bundle, which
 * makes every assertion built on it pass against unpatched code. The optional
 * `\)?` is what gives this matcher its discriminating power; the canary test
 * below pins that behavior so the vacuous form cannot come back.
 */
const DESTRUCTIVE_DELETE = /_item\s*\)?\s*\.delete\(transaction\)/;

/**
 * Directories under a package that can hold shipped code. `dist` alone is not
 * enough: `y-prosemirror` serves its `import` condition straight out of `src/`,
 * so a `dist`-only sweep misses the copy the browser build actually loads.
 */
const ARTIFACT_ROOTS = ['dist', 'src', 'lib', 'build', 'esm', 'cjs'] as const;

/** Depth cap so a pathological symlink cycle cannot hang the sweep. */
const MAX_ARTIFACT_DEPTH = 6;

/**
 * Every `node_modules` directory the dep-tree walk must start from.
 *
 * pnpm installs with an isolated layout: the repo-root `node_modules/` holds
 * only the workspace ROOT package's own dependencies, and each workspace
 * package's dependencies live in the dot-prefixed `.pnpm/` virtual store
 * (surfaced to packages via symlinks). A walk that starts at the repo root and
 * skips dot-directories therefore never reaches a single workspace-package
 * dependency — including the two packages these patches exist to guard. The
 * store is enumerated explicitly for that reason; `walkInstalledPackageDirs`
 * de-dupes by realpath, so hoisted layouts (Bun/npm) still work through the
 * repo-root entry alone and cost nothing extra here.
 */
function installedPackageRoots(): string[] {
  const rootNodeModules = join(REPO_ROOT, 'node_modules');
  const roots = [rootNodeModules];

  const store = join(rootNodeModules, '.pnpm');
  let storeEntries: string[];
  try {
    storeEntries = readdirSync(store);
  } catch {
    return roots; // Not a pnpm layout — the repo-root walk already covers it.
  }
  for (const entry of storeEntries) {
    roots.push(join(store, entry, 'node_modules'));
  }
  return roots;
}

function resolveFileFromSpecifier(specifier: string): string {
  const resolved = import.meta.resolve(specifier);
  return resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
}

function resolveInstalledPackageDir(packageName: string): string {
  let dir = dirname(resolveFileFromSpecifier(packageName));

  while (true) {
    const pkgJsonPath = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
      if (pkg.name === packageName) return dir;
    } catch {
      // Keep walking upward until we find the package root.
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Could not resolve installed package directory for ${packageName}`);
}

function walkInstalledPackageDirs(
  nodeModulesDir: string,
  visitPackageDir: (pkgDir: string) => void,
  visited = new Set<string>(),
) {
  let entries: string[];
  try {
    entries = readdirSync(nodeModulesDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(nodeModulesDir, name);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    if (name.startsWith('@')) {
      walkInstalledPackageDirs(full, visitPackageDir, visited);
      continue;
    }

    let pkgDir = full;
    try {
      pkgDir = realpathSync(full);
    } catch {
      // Fall back to the directory entry itself if realpath fails.
    }
    if (visited.has(pkgDir)) continue;
    visited.add(pkgDir);
    visitPackageDir(pkgDir);
    walkInstalledPackageDirs(join(pkgDir, 'node_modules'), visitPackageDir, visited);
  }
}

/**
 * Every patched artifact in our dep tree that ships its own copy of the
 * destructive-delete code. All are real production paths:
 * `@tiptap/extension-collaboration-cursor` imports from `y-prosemirror`;
 * `@tiptap/extension-collaboration` and our 27+ direct imports go through
 * `@tiptap/y-tiptap`. Patching only one leaves a live CRDT data-loss bug in
 * the other.
 *
 * `y-prosemirror` needs TWO entries because it ships two copies of the same
 * code and its `exports["."]` map serves them by condition: `require` gets
 * `dist/y-prosemirror.cjs`, `import` gets `src/y-prosemirror.js`, which
 * re-exports `ySyncPlugin` / `updateYFragment` from `src/plugins/sync-plugin.js`.
 * The Vite build of `packages/app` takes the `import` condition, so `src/` is
 * the copy that actually reaches the browser and asserting only against
 * `dist/` would leave the shipped path unguarded. `@tiptap/y-tiptap` needs no
 * equivalent entry — its `import` condition also resolves into `dist/`.
 */
const PATCHED_BUNDLES = [
  {
    label: 'y-prosemirror CJS',
    packageName: 'y-prosemirror',
    relativePath: ['dist', 'y-prosemirror.cjs'],
  },
  {
    label: 'y-prosemirror ESM src',
    packageName: 'y-prosemirror',
    relativePath: ['src', 'plugins', 'sync-plugin.js'],
  },
  {
    label: '@tiptap/y-tiptap CJS',
    packageName: '@tiptap/y-tiptap',
    relativePath: ['dist', 'y-tiptap.cjs'],
  },
  {
    label: '@tiptap/y-tiptap ESM',
    packageName: '@tiptap/y-tiptap',
    relativePath: ['dist', 'y-tiptap.js'],
  },
] as const;

function resolvePatchedBundlePath(bundle: (typeof PATCHED_BUNDLES)[number]): string {
  return join(resolveInstalledPackageDir(bundle.packageName), ...bundle.relativePath);
}

describe('R13 patch verification (y-prosemirror + @tiptap/y-tiptap)', () => {
  /**
   * Canary for the matcher every destructive-delete assertion in this file is
   * built on. Those assertions are all negative (`not.toMatch`, "no offending
   * file found"), so a matcher that matches nothing makes all of them pass —
   * against a patched bundle AND against a fully stock one. Nothing else in
   * this file can catch that, because a vacuous negative assertion looks
   * exactly like a satisfied one.
   *
   * The two fixtures are the verbatim upstream call sites from stock
   * `y-prosemirror@1.3.7` `src/plugins/sync-plugin.js` (the block-context site
   * in `createNodeFromYElement` and the inline-context site in
   * `createTextNodesFromYText`).
   */
  test('destructive-delete matcher matches the upstream shape it guards against', () => {
    const upstreamBlockContext = '/** @type {Y.Item} */ (el._item).delete(transaction)';
    const upstreamInlineContext = '/** @type {Y.Item} */ (text._item).delete(transaction)';

    expect(upstreamBlockContext).toMatch(DESTRUCTIVE_DELETE);
    expect(upstreamInlineContext).toMatch(DESTRUCTIVE_DELETE);

    // And it must not fire on the patched replacement, or every bundle would
    // report as unpatched.
    expect("schema.node('rawMdxFallback', { value: raw })").not.toMatch(DESTRUCTIVE_DELETE);
  });

  test('both patches are registered in pnpm-workspace.yaml patchedDependencies', () => {
    // pnpm declares patches in pnpm-workspace.yaml (not package.json, where Bun
    // kept them). Parse the block with a line matcher to avoid a YAML dependency.
    const workspaceYaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const block = workspaceYaml.match(/^patchedDependencies:\n((?:[ \t]+\S.*\n?)+)/m);
    expect(block).not.toBeNull();
    const patched: Record<string, string> = {};
    for (const line of (block?.[1] ?? '').split('\n')) {
      const entry = line.match(/^\s+(['"]?)(.+?)\1:\s+(\S+)\s*$/);
      if (entry) patched[entry[2]] = entry[3];
    }

    expect(patched['y-prosemirror@1.3.7']).toBeDefined();
    expect(patched['y-prosemirror@1.3.7']).toContain('patches/');
    expect(patched['y-prosemirror@1.3.7']).toContain('y-prosemirror');

    expect(patched['@tiptap/y-tiptap@3.0.3']).toBeDefined();
    expect(patched['@tiptap/y-tiptap@3.0.3']).toContain('patches/');
    expect(patched['@tiptap/y-tiptap@3.0.3']).toContain('y-tiptap');
  });

  for (const bundle of PATCHED_BUNDLES) {
    describe(bundle.label, () => {
      test('contains R13 patch body (not upstream destructive-delete)', () => {
        const src = readFileSync(resolvePatchedBundlePath(bundle), 'utf8');

        // Patch markers must be present at BOTH throw sites
        const patchMarkers = src.match(/R13 patch:/g);
        expect(patchMarkers).not.toBeNull();
        expect(patchMarkers?.length).toBeGreaterThanOrEqual(2);

        // rawMdxFallback substitution path must be present in block-context catch
        expect(src).toContain("schema.node('rawMdxFallback'");

        // globalThis counter bridge must be wired at both the block and text
        // catch sites so ypsMismatch counters report real values through the
        // /api/metrics/parse-health endpoint.
        const counterMarkers = src.match(/__okYpsCounters/g);
        expect(counterMarkers).not.toBeNull();
        // At minimum: block-context increment + inline-context increment + text-site increment
        expect(counterMarkers?.length).toBeGreaterThanOrEqual(3);

        // The structured console.warn for developer-facing signal must fire
        expect(src).toMatch(/\[y-prosemirror\] schema\.node\(/);
        expect(src).toMatch(/\[y-prosemirror\] schema\.text\(/);
      });

      test('contains the ymark: mark-encoding (not upstream mark-drop)', () => {
        const src = readFileSync(resolvePatchedBundlePath(bundle), 'utf8');

        // These identifiers carry ProseMirror marks on inline element/leaf
        // nodes across the Y bridge, encoded as `ymark:`-prefixed reserved
        // attributes. They are a SEPARATE concern from the R13 delete-fix and
        // are the exact surface that vanishes if a version bump re-ports the
        // delete-fix but drops the mark encoding.
        //
        // On the y-prosemirror artifacts this is the SOLE line of defense:
        // every functional mark test imports through @tiptap/y-tiptap, so a
        // y-prosemirror-only regression is silent mark loss on the
        // collaboration-cursor import path with nothing else to catch it. On
        // the @tiptap/y-tiptap artifacts it is deliberate defense-in-depth —
        // functional tests do cover that path, but only one of its two dist
        // artifacts at a time and only with a server running, so a re-port
        // that drops the encoding from just one of them still fails here, at
        // unit-test time. A failure on a y-tiptap bundle is therefore real,
        // not redundant.
        //
        // Thresholds, not exact counts, so a re-bundle that inlines or
        // duplicates a call site does not fail spuriously.
        const prefixMarkers = src.match(/YMARK_PREFIX/g);
        expect(prefixMarkers).not.toBeNull();
        // At minimum: the constant declaration + one encode + one decode site.
        expect(prefixMarkers?.length).toBeGreaterThanOrEqual(3);

        // Patch-introduced helpers: declaration + at least one call site. Both
        // are absent from a stock bundle, so this is the assertion that fails
        // on a dropped re-port.
        for (const helper of ['splitYAttrs', 'equalYMarks']) {
          const helperMarkers = src.match(new RegExp(helper, 'g'));
          expect(helperMarkers, `${helper} missing from ${bundle.label}`).not.toBeNull();
          expect(helperMarkers?.length).toBeGreaterThanOrEqual(2);
        }

        // `yattr2markname` is UPSTREAM code — the patch only adds a call site,
        // so it is asserted as a dependency pin rather than a patch marker: a
        // version bump that drops the upstream helper breaks `equalYMarks`,
        // and this fails at test time instead of silently at re-port time.
        // Deliberately no occurrence threshold — any floor a stock bundle
        // already clears would prove nothing.
        expect(src).toContain('yattr2markname');

        // The reserved attribute-key prefix itself — the wire format that both
        // the encode and decode halves agree on.
        expect(src).toContain('ymark:');
      });

      test('patched throw sites do NOT retain upstream destructive _item.delete calls', () => {
        const src = readFileSync(resolvePatchedBundlePath(bundle), 'utf8');

        // Split on 'R13 patch:' and for each hunk, verify the patch body does
        // NOT contain the destructive delete the patch replaced.
        const hunks = src.split(/R13 patch:/);
        // The first hunk is everything BEFORE the first patch marker — skip it.
        for (let i = 1; i < hunks.length; i++) {
          const hunk = hunks[i].slice(0, 4000);
          expect(hunk).not.toMatch(DESTRUCTIVE_DELETE);
        }

        // Stronger check: no destructive delete anywhere in the bundle. Both
        // call sites (block + text) lived only in the patched catch blocks;
        // after patching, neither bundle should reference it at all.
        expect(src).not.toMatch(DESTRUCTIVE_DELETE);
      });
    });
  }

  /**
   * The ymark encoding must survive a re-port in the PATCH FILE, not just in
   * the installed bundle. The per-bundle assertions above only run after
   * `pnpm install` has applied the patch; asserting the same identifiers
   * against the patch source fails a dropped-encoding re-port at patch-review
   * time, which is where it is cheapest to fix.
   */
  function expectYmarkEncoding(patchContent: string) {
    for (const identifier of ['YMARK_PREFIX', 'splitYAttrs', 'equalYMarks', 'yattr2markname']) {
      expect(patchContent, `${identifier} missing from patch file`).toContain(identifier);
    }
  }

  test('y-prosemirror patch file exists on disk and references both artifacts', () => {
    const patchPath = join(REPO_ROOT, 'patches', 'y-prosemirror@1.3.7.patch');
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('y-prosemirror.cjs');
    // The `import` condition resolves here, so a patch that touches only the
    // CJS artifact ships an unpatched editor. Asserting it against the patch
    // file catches an incomplete re-port before `pnpm install` applies it.
    expect(patchContent).toContain('src/plugins/sync-plugin.js');
    expect(patchContent).toContain('R13 patch:');
    expect(patchContent).toContain('rawMdxFallback');
    expect(patchContent).toContain('__okYpsCounters');
    expectYmarkEncoding(patchContent);
  });

  test('@tiptap/y-tiptap patch file exists on disk and references both bundles', () => {
    // Scoped-package patch filenames encode `/` as `%2F`.
    const patchPath = join(REPO_ROOT, 'patches', '@tiptap%2Fy-tiptap@3.0.3.patch');
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('dist/y-tiptap.cjs');
    expect(patchContent).toContain('dist/y-tiptap.js');
    expect(patchContent).toContain('R13 patch:');
    expect(patchContent).toContain('rawMdxFallback');
    expect(patchContent).toContain('__okYpsCounters');
    expectYmarkEncoding(patchContent);
  });

  /**
   * Dep-tree invariant: NO shipped bundle anywhere in node_modules retains the
   * upstream destructive-delete pattern `(el._item).delete(transaction)`. This
   * is the future-proof gate — if a new dependency ships another vendored copy
   * of the same code, this test fails in CI and points at the exact file, so
   * the patch surface is extended before the regression can ship.
   *
   * Why this is architecturally the right gate (vs. enumerating known bundles):
   * y-prosemirror and @tiptap/y-tiptap both bundle the same destructive-delete
   * code. Different Tiptap extensions import from different packages — e.g.
   * @tiptap/extension-collaboration uses y-tiptap; @tiptap/extension-
   * collaboration-cursor uses y-prosemirror. Any future Tiptap consolidation
   * (or new vendor) could re-introduce another copy. Listing known-bad bundles
   * makes it trivially easy to miss the next one; checking the invariant
   * mechanically cannot.
   *
   * Scoping: scans `.js` / `.cjs` / `.mjs` recursively under each reachable
   * package's ARTIFACT_ROOTS, skipping nested `node_modules/` (visited as
   * packages in their own right) and dot-directories. The walk starts from
   * every root in `installedPackageRoots()` with shared realpath de-dupe, so
   * it covers hoisted (Bun/npm) and isolated (pnpm) layouts alike.
   *
   * The sweep asserts reachability BEFORE it reports offenders: a walk that
   * reaches nothing finds zero offending files and is indistinguishable from a
   * clean tree, which is exactly how this invariant silently stopped covering
   * anything when the repo moved off Bun's hoisted layout.
   */
  // Filesystem-heavy walk over the entire node_modules tree — reads every
  // `.js`/`.cjs`/`.mjs` under each package's artifact roots. Wall time is
  // dominated by bytes read (roughly 400 MB here) and so varies with FS-cache
  // state (cold runner vs. warm cache) and total dep count; the default 5s
  // timeout is too tight and produces spurious flakes (observed 9.7s on a
  // cold CI runner). 30s leaves comfortable headroom while still failing
  // loud on a genuine hang.
  test('dep-tree invariant: no destructive delete in any shipped bundle', () => {
    const offending: Array<{ path: string; line: number }> = [];
    const reachedPackages = new Set<string>();

    function scanArtifactDir(dir: string, depth: number) {
      if (depth > MAX_ARTIFACT_DEPTH) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanArtifactDir(full, depth + 1);
          continue;
        }
        if (!/\.(?:js|cjs|mjs)$/.test(entry.name)) continue;
        let src: string;
        try {
          src = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (!DESTRUCTIVE_DELETE.test(src)) continue;
        // Report first offending line for actionable failure output.
        const lines = src.split('\n');
        const lineIdx = lines.findIndex((l) => DESTRUCTIVE_DELETE.test(l));
        offending.push({ path: full, line: lineIdx + 1 });
      }
    }

    function scanPackageDir(pkgDir: string) {
      reachedPackages.add(basename(pkgDir));
      for (const artifactRoot of ARTIFACT_ROOTS) {
        scanArtifactDir(join(pkgDir, artifactRoot), 0);
      }
    }

    const visited = new Set<string>();
    for (const root of installedPackageRoots()) {
      walkInstalledPackageDirs(root, scanPackageDir, visited);
    }

    // Reachability canary — see the header comment. A zero-offender result is
    // only meaningful if the packages this patch guards were actually visited.
    for (const guarded of ['y-prosemirror', 'y-tiptap']) {
      expect(
        reachedPackages.has(guarded),
        `dep-tree walk never reached "${guarded}" (visited ${reachedPackages.size} packages), ` +
          `so a zero-offender result proves nothing. The node_modules layout has probably ` +
          `changed — extend installedPackageRoots() to cover it.`,
      ).toBe(true);
    }

    if (offending.length > 0) {
      const details = offending.map(({ path, line }) => `  ${path}:${line}`).join('\n');
      throw new Error(
        `Found ${offending.length} bundle(s) with the upstream destructive-delete pattern ` +
          `\`(el._item).delete(transaction)\`. Every such bundle must be patched via \`pnpm patch\` ` +
          `to substitute rawMdxFallback (block-context) or log+skip (inline-context); ` +
          `otherwise a schema.node()/schema.text() throw will tombstone Y.Items and ` +
          `broadcast the delete to all peers (see PRECEDENTS.md precedent #9):\n${details}`,
      );
    }
  }, 30_000);
});
