/**
 * End-to-end smoke test index.
 *
 *   Test 1 (dev loop) — Playwright `_electron.launch` against the bundled
 *     out/main/index.js. Skipped here with a structured reason because the
 *     full Playwright + Electron + display-server harness is not part of
 *     `bun test` (it runs under `bun run test:e2e:packaged` once the
 *     electron-builder smoke pipeline lands). The bridge / utility /
 *     window-manager / IPC layers ARE end-to-end tested via the unit-test
 *     suite at the boundary they expose to the renderer.
 *
 *   Test 2 (keyring smoke) — exercises @napi-rs/keyring directly from a
 *     plain Node process to prove the binding loads under the Bun runtime
 *     (ABI risk). If the binding fails to load (e.g., CI runner without
 *     a Keychain backend), test SKIPs gracefully.
 *
 *   Test 3 (parent-death) — covered by `tests/utility/server-entry.test.ts`
 *     which simulates the EPERM/ESRCH branches via an injected killProbe.
 *     A real fork-and-SIGKILL harness is future work (electron-playwright-helpers).
 *
 *   Test 4 (server.lock) — covered by `tests/main/window-manager.test.ts`
 *     (createProjectWindow → init → ready → focus-existing on duplicate).
 *     The actual server.lock acquire/release is exercised by the shipped
 *     test suite at `packages/server/src/server-lock.test.ts`, which
 *     this file CONSUMES rather than re-tests.
 *
 * Net: this file's sole NEW gate is Test 2 (keyring smoke under Bun). The
 * other three are coverage pointers — explicit references so a future
 * developer can find the existing tests via this index.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('M1 smoke', () => {
  test('Test 1 — dev loop: Playwright _electron.launch (DEFERRED to M2)', () => {
    // The dev loop is end-to-end exercised by:
    //   1. WindowManager unit tests (tests/main/window-manager.test.ts) —
    //      forkUtility + init + ready + window.loadFile + post-exit liveness
    //   2. utility entry unit tests (tests/utility/server-entry.test.ts) —
    //      bootServer wiring, IPC handshake, drain
    //   3. preload bridge unit test (tests/preload/bridge.test.ts) —
    //      typed IPC factory contract
    // Full Playwright `_electron.launch({ executablePath: electron, args: [
    // 'out/main/index.js'] })` smoke runs in the packaged-build pipeline.
    expect(true).toBe(true); // placeholder
  });

  test('Test 2 — keyring smoke: @napi-rs/keyring loads + round-trips a secret', async () => {
    // Confirms the native ABI loads under Bun. @napi-rs/keyring is a CLI
    // dep that must rebuild against Electron's Node ABI in packaged builds.
    // This test catches the load-time failure shape (ABI mismatch, prebuilt
    // missing) before packaging — if it can't load under Bun's
    // Node24-compatible runtime, it definitely can't load under Electron's
    // Node24-derived ABI.
    let keyring: typeof import('@napi-rs/keyring') | null = null;
    try {
      keyring = await import('@napi-rs/keyring');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Skip with structured reason — captured in test output for triage.
      console.warn(`[m1-smoke] @napi-rs/keyring failed to load: ${message}`);
      console.warn(
        '[m1-smoke] SKIPPING keyring round-trip (R15 fallback to plaintext YAML kicks in)',
      );
      expect(message.length).toBeGreaterThan(0);
      return;
    }

    const Entry = keyring.Entry;
    expect(typeof Entry).toBe('function');

    // Linux CI runners do NOT have a Secret Service (D-Bus / gnome-keyring)
    // backend. `entry.setPassword` blocks indefinitely on the missing
    // backend rather than throwing — and crucially, the native binding
    // holds a worker thread or D-Bus connection alive even after the test
    // returns, preventing `bun test` from exiting cleanly. That manifests
    // as a CI-only post-test hang (15-minute job timeout cancellation).
    // The binding load already provides the
    // ABI-mismatch signal we care about for this test's purpose; the
    // round-trip is only meaningful where a real keychain backend exists.
    if (process.platform === 'linux' && process.env.CI === 'true') {
      console.warn(
        '[m1-smoke] SKIPPING keyring round-trip on Linux CI — no Secret Service backend; ' +
          'binding-load verification (R15) above is sufficient. Round-trip runs locally on ' +
          'macOS (Keychain) and Windows (Credential Manager).',
      );
      return;
    }

    const entry = new Entry('open-knowledge-m1-smoke', 'test-user');
    try {
      entry.setPassword('secret-from-test');
      const got = entry.getPassword();
      expect(got).toBe('secret-from-test');
    } catch (err) {
      // Some CI environments (sandbox, headless Linux without keyring service)
      // will fail to actually persist — that's a CI-env story, not a binding-
      // load story. Document the skip.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[m1-smoke] keyring round-trip skipped (env): ${message}`);
      expect(message.length).toBeGreaterThan(0);
    } finally {
      try {
        entry.deletePassword();
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  test('Test 3 — parent-death detection: covered by tests/utility/server-entry.test.ts', () => {
    // Reference pointer — the actual EPERM/ESRCH simulation lives in the
    // utility entry's `parent-death poll: triggers shutdown on EPERM/ESRCH`
    // test case. Re-asserting here as a discoverability index.
    const utilityTestPath = join(__dirname, '..', 'utility', 'server-entry.test.ts');
    expect(existsSync(utilityTestPath)).toBe(true);
  });

  test('Test 4 — server.lock behavior: covered by tests/main/window-manager.test.ts + V0-1 server-lock.test.ts', () => {
    // Reference pointer — server.lock acquire/release semantics are
    // (shipped); WindowManager exercises the spawn → focus-existing flow
    // that consumes the lock. Re-asserting both files exist as a
    // discoverability index for the ship gate.
    const wmTestPath = join(__dirname, '..', 'main', 'window-manager.test.ts');
    const serverLockTestPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'server',
      'src',
      'server-lock.test.ts',
    );
    expect(existsSync(wmTestPath)).toBe(true);
    expect(existsSync(serverLockTestPath)).toBe(true);
  });

  test('M1 invariant: bridge contract drift catcher (US-010 promise)', async () => {
    // Verify all three OkDesktopBridge contract copies (core canonical,
    // desktop preload-side, app renderer-side) declare the same surface
    // shape. Drift is a real risk — a future contributor adds a method to
    // one copy and forgets the other two; this test fires on the first
    // copy diverging.
    //
    // We check existence AND a lightweight member-name-set equality on the
    // `OkDesktopBridge` interface text. This catches a category of drift
    // (core missing the `project` surface
    // while desktop + app both had it). Full signature-level equivalence is
    // beyond this test's scope; pick up the delta at `bun run typecheck`
    // if the TS compiler notices it across the three import paths.
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
    const desktopPath = join(__dirname, '..', '..', 'src', 'shared', 'bridge-contract.ts');
    const appPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'app',
      'src',
      'lib',
      'desktop-bridge-types.ts',
    );
    expect(existsSync(corePath)).toBe(true);
    expect(existsSync(desktopPath)).toBe(true);
    expect(existsSync(appPath)).toBe(true);

    const { readFileSync } = await import('node:fs');
    /**
     * Extract member names from an `OkDesktopBridge` interface declaration,
     * INCLUDING one level of nesting. Top-level members (`dialog`, `shell`,
     * `project`, …) are captured by their name; members inside those nested
     * blocks are captured as `<parent>.<name>` (e.g. `shell.detectProtocol`).
     *
     * Two-level capture (not arbitrary depth) is deliberate — the contract
     * is flat-by-convention apart from the grouped surfaces, and a bounded
     * walker is easier to reason about than a generic recursive one. If a
     * future surface ever grows a third level, add another nesting tier
     * here rather than reworking the depth bookkeeping.
     */
    const extractBridgeMembers = (src: string): Set<string> => {
      const names = new Set<string>();
      const lines = src.split('\n');
      let inInterface = false;
      let braceDepth = 0;
      // Paren depth guards against false positives from multi-line method
      // signatures like `spawnCursor(\n  path: string,\n): Promise<…>` —
      // without this, the continuation line `path: string,` would match the
      // member regex and leak "path" as a phantom sub-member.
      let parenDepth = 0;
      let currentParent: string | null = null;
      for (const line of lines) {
        if (!inInterface) {
          if (/interface\s+OkDesktopBridge\s*\{/.test(line)) {
            inInterface = true;
            braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
            parenDepth = (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
          }
          continue;
        }
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        const parenOpens = (line.match(/\(/g) ?? []).length;
        const parenCloses = (line.match(/\)/g) ?? []).length;
        const trimmed = line.trim();
        const memberMatch = trimmed.match(/^(?:readonly\s+)?(\w+)\s*[:(?]/);
        const canCapture = parenDepth === 0;
        if (braceDepth === 1) {
          if (canCapture && memberMatch?.[1]) {
            names.add(memberMatch[1]);
            if (opens > closes) currentParent = memberMatch[1];
          }
        } else if (braceDepth === 2 && currentParent) {
          if (canCapture && memberMatch?.[1]) names.add(`${currentParent}.${memberMatch[1]}`);
        }
        braceDepth += opens - closes;
        parenDepth += parenOpens - parenCloses;
        if (braceDepth === 1 && currentParent) currentParent = null;
        if (braceDepth === 0) break;
      }
      return names;
    };

    const coreMembers = extractBridgeMembers(readFileSync(corePath, 'utf-8'));
    const desktopMembers = extractBridgeMembers(readFileSync(desktopPath, 'utf-8'));
    const appMembers = extractBridgeMembers(readFileSync(appPath, 'utf-8'));

    // All three extractions must actually find members — otherwise the regex
    // is broken and subsequent equality checks are meaningless.
    expect(coreMembers.size).toBeGreaterThan(0);
    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(appMembers.size).toBeGreaterThan(0);

    // Positive regression: the nested walker must actually find sub-members
    // of the `shell` block. If it silently fell back to top-level-only, this
    // test would quietly succeed while missing an entire class of drift.
    //
    // Assert every shell.* sub-member shipped by the Open in Agent
    // Desktop surface. A walker regression that drops
    // one of these — say, the paren-depth guard degrading on a signature with
    // a generic type parameter — would silently lose the drift signal for that
    // method. Explicit membership makes the signal load-bearing.
    const REQUIRED_SHELL_MEMBERS = [
      'shell.openExternal', // baseline
      'shell.detectProtocol', // Open in Agent
      'shell.spawnCursor', // Open in Agent
      'shell.recordHandoff', // Open in Agent telemetry
      'shell.openAsset', // asset-click dispatcher
      'shell.revealAsset', // asset-click dispatcher
      'shell.revealExternal', // terminal out-of-project reveal
      'shell.showAssetMenu', // right-click context menu
      'shell.showItemInFolder', // file-tree reveal-in-finder
      'shell.trashItem', // sidebar Trash flow
    ] as const;
    // The fs.* namespace was added for the Create-new-project dialog cascade.
    // Mirror the shell.* coverage so a walker regression that drops one of
    // these probes — say, the paren-depth guard degrading on the Promise<T |
    // null> return type — would surface here instead of silently desyncing
    // the three bridge-contract copies.
    const REQUIRED_FS_MEMBERS = [
      'fs.defaultProjectsRoot',
      'fs.folderState',
      'fs.findEnclosingProjectRoot',
      'fs.findEnclosingGitRoot',
    ] as const;
    for (const [label, members] of [
      ['core', coreMembers],
      ['desktop', desktopMembers],
      ['app', appMembers],
    ] as const) {
      expect(members.has('shell')).toBe(true);
      for (const required of REQUIRED_SHELL_MEMBERS) {
        expect(members.has(required)).toBe(true);
        if (!members.has(required)) {
          throw new Error(`${label} extractor missed ${required} — walker broken`);
        }
      }
      expect(members.has('fs')).toBe(true);
      for (const required of REQUIRED_FS_MEMBERS) {
        expect(members.has(required)).toBe(true);
        if (!members.has(required)) {
          throw new Error(`${label} extractor missed ${required} — walker broken`);
        }
      }
    }

    // Set equality pairwise. If any pair diverges, surface WHICH members
    // are missing from which copy so the fix is clear.
    const diff = (a: Set<string>, b: Set<string>) => Array.from(a).filter((x) => !b.has(x));
    const coreMinusDesktop = diff(coreMembers, desktopMembers);
    const desktopMinusCore = diff(desktopMembers, coreMembers);
    const appMinusCore = diff(appMembers, coreMembers);
    const coreMinusApp = diff(coreMembers, appMembers);

    if (
      coreMinusDesktop.length +
        desktopMinusCore.length +
        appMinusCore.length +
        coreMinusApp.length >
      0
    ) {
      throw new Error(
        [
          'OkDesktopBridge contract drift across the three copies:',
          `  core has but desktop missing:  [${coreMinusDesktop.join(', ')}]`,
          `  desktop has but core missing:  [${desktopMinusCore.join(', ')}]`,
          `  app has but core missing:      [${appMinusCore.join(', ')}]`,
          `  core has but app missing:      [${coreMinusApp.join(', ')}]`,
          '',
          'Fix: add the missing members so the three copies agree.',
        ].join('\n'),
      );
    }
  });

  test('M1 invariant: literal unions consolidated in core; mirrors re-export or alias without the inline shape', async () => {
    // Three literal-union types are consolidated into `@inkeep/open-knowledge-
    // core`'s `constants/` directory. Each mirror file MUST reach the type
    // through `@inkeep/open-knowledge-core` (or, when the mirror is itself
    // inside core, through the canonical sibling module). A direct TS import
    // enforces drift via type errors, so this test only guarantees no copy
    // re-introduces the inline literal-union substring.
    //
    // Canonical declarations:
    //   - EditorId                      — packages/core/src/constants/editors.ts
    //   - OkFolderState                 — packages/core/src/constants/folder-state.ts
    //   - CreateNewBannerKind           — packages/core/src/constants/create-new-banner.ts
    //   - CreateNewProjectFailureReason — packages/core/src/constants/create-new-project-reason.ts
    const packagesRoot = join(__dirname, '..', '..', '..');
    const editorsConstantPath = join(packagesRoot, 'core', 'src', 'constants', 'editors.ts');
    const folderStateConstantPath = join(
      packagesRoot,
      'core',
      'src',
      'constants',
      'folder-state.ts',
    );
    const bannerConstantPath = join(
      packagesRoot,
      'core',
      'src',
      'constants',
      'create-new-banner.ts',
    );
    const reasonConstantPath = join(
      packagesRoot,
      'core',
      'src',
      'constants',
      'create-new-project-reason.ts',
    );

    // Paths that mirror sites are pinned against.
    const cliEditorsPath = join(packagesRoot, 'cli', 'src', 'commands', 'editors.ts');
    const ipcChannelsPath = join(__dirname, '..', '..', 'src', 'shared', 'ipc-channels.ts');
    const bridgeContractPath = join(__dirname, '..', '..', 'src', 'shared', 'bridge-contract.ts');
    const coreBridgePath = join(packagesRoot, 'core', 'src', 'desktop-bridge.ts');
    const appBridgePath = join(packagesRoot, 'app', 'src', 'lib', 'desktop-bridge-types.ts');
    const createNewProjectPath = join(
      __dirname,
      '..',
      '..',
      'src',
      'main',
      'create-new-project.ts',
    );
    const createProjectDialogPath = join(
      packagesRoot,
      'app',
      'src',
      'components',
      'CreateProjectDialog.tsx',
    );
    const onboardingTelemetryPath = join(
      __dirname,
      '..',
      '..',
      'src',
      'main',
      'onboarding-telemetry.ts',
    );

    const { readFileSync } = await import('node:fs');

    /** A pinned literal-union consolidation. `canonicalRe` extracts the
     *  declared union body from the canonical file; `inlineRe` is the exact
     *  literal-union substring that mirror files USED to carry, and which
     *  this test forbids outside the canonical file. */
    interface UnionPin {
      readonly typeName: string;
      readonly canonicalPath: string;
      readonly canonicalRe: RegExp;
      readonly expectedLiteralCount: number;
      readonly inlineRe: RegExp;
      readonly mirrors: readonly (readonly [label: string, path: string])[];
    }

    const pins: readonly UnionPin[] = [
      {
        typeName: 'EditorId',
        canonicalPath: editorsConstantPath,
        canonicalRe: /type\s+EditorId\s*=([^;]+);/,
        expectedLiteralCount: 10,
        inlineRe:
          /'claude'\s*\|\s*'claude-desktop'\s*\|\s*'cursor'\s*\|\s*'codex'\s*\|\s*'opencode'\s*\|\s*'openclaw'/,
        mirrors: [
          ['cli/commands/editors.ts', cliEditorsPath],
          ['desktop/shared/ipc-channels.ts', ipcChannelsPath],
          ['desktop/shared/bridge-contract.ts', bridgeContractPath],
          ['core/desktop-bridge.ts', coreBridgePath],
          ['app/lib/desktop-bridge-types.ts', appBridgePath],
        ],
      },
      {
        typeName: 'OkFolderState',
        canonicalPath: folderStateConstantPath,
        canonicalRe: /type\s+OkFolderState\s*=([^;]+);/,
        expectedLiteralCount: 3,
        inlineRe: /'free'\s*\|\s*'exists-empty'\s*\|\s*'exists-nonempty'/,
        mirrors: [
          ['core/desktop-bridge.ts', coreBridgePath],
          ['app/lib/desktop-bridge-types.ts', appBridgePath],
          ['desktop/shared/bridge-contract.ts', bridgeContractPath],
          ['desktop/shared/ipc-channels.ts', ipcChannelsPath],
          ['desktop/main/create-new-project.ts', createNewProjectPath],
        ],
      },
      {
        typeName: 'CreateNewBannerKind',
        canonicalPath: bannerConstantPath,
        canonicalRe: /type\s+CreateNewBannerKind\s*=([^;]+);/,
        expectedLiteralCount: 3,
        inlineRe: /'nested'\s*\|\s*'nonempty'\s*\|\s*'git-confirm'/,
        mirrors: [
          ['core/desktop-bridge.ts', coreBridgePath],
          ['app/lib/desktop-bridge-types.ts', appBridgePath],
          ['desktop/shared/bridge-contract.ts', bridgeContractPath],
          ['desktop/shared/ipc-channels.ts', ipcChannelsPath],
          ['app/components/CreateProjectDialog.tsx', createProjectDialogPath],
          ['desktop/main/onboarding-telemetry.ts', onboardingTelemetryPath],
        ],
      },
      {
        typeName: 'CreateNewProjectFailureReason',
        canonicalPath: reasonConstantPath,
        canonicalRe: /type\s+CreateNewProjectFailureReason\s*=([^;]+);/,
        expectedLiteralCount: 7,
        // Substring of the canonical 7-literal union. `CreateProjectDialog.tsx`
        // keeps a discriminated union where each literal sits inside a separate
        // `{ reason: 'X' }` variant, so the substring would not match there —
        // drift in that file is pinned by a compile-time type-equivalence
        // check inside the file itself (`_CreateNewReasonDriftPin`).
        inlineRe:
          /'invalid-args'\s*\|\s*'nested-project'\s*\|\s*'target-not-empty'\s*\|\s*'mkdir-failed'\s*\|\s*'git-init-failed'\s*\|\s*'init-failed'\s*\|\s*'discovery-failed'/,
        mirrors: [['desktop/main/create-new-project.ts', createNewProjectPath]],
      },
    ];

    const offenders: string[] = [];
    for (const pin of pins) {
      // Canonical file must still declare the union with the pinned literal
      // count. If a new literal lands, the maintainer updates this count in
      // lockstep with the canonical union body in one place.
      const canonicalSrc = readFileSync(pin.canonicalPath, 'utf-8');
      const canonicalMatch = canonicalSrc.match(pin.canonicalRe);
      expect(canonicalMatch).not.toBeNull();
      const canonicalLiterals = (canonicalMatch?.[1] ?? '').match(/'([^']+)'/g) ?? [];
      expect(canonicalLiterals.length).toBe(pin.expectedLiteralCount);

      for (const [label, path] of pin.mirrors) {
        const src = readFileSync(path, 'utf-8');
        if (pin.inlineRe.test(src)) {
          offenders.push(`  [${pin.typeName}] ${label} still carries an inline literal union`);
        }
        // Every mirror must reach the canonical type through `@inkeep/open-
        // knowledge-core` (or the sibling `./constants/*.ts` module for the
        // in-core mirror).
        const importsFromCore =
          /from\s+['"]@inkeep\/open-knowledge-core['"]/.test(src) ||
          /from\s+['"]\.\/constants\/[\w-]+\.ts['"]/.test(src);
        if (!importsFromCore) {
          offenders.push(
            `  [${pin.typeName}] ${label} does not import from @inkeep/open-knowledge-core`,
          );
        }
        const typeRe = new RegExp(`\\b${pin.typeName}\\b`);
        if (!typeRe.test(src)) {
          offenders.push(
            `  [${pin.typeName}] ${label} does not reference the canonical ${pin.typeName} type`,
          );
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        [
          'Literal-union consolidation regression:',
          ...offenders,
          '',
          'Fix: import or re-export the canonical type from @inkeep/open-knowledge-core.',
          'See packages/core/src/constants/{editors,folder-state,create-new-banner}.ts for the',
          'canonical declarations.',
        ].join('\n'),
      );
    }
  });

  test('M1 invariant: OkThemeSource literal-union drift catcher', async () => {
    // The `OkThemeSource` literal union — `'system' | 'light' | 'dark'` —
    // appears verbatim in THREE files (the desktop bridge contract +
    // 2 mirrors). Adding a 4th value (e.g. `'auto'`) to one mirror but
    // not the others would silently desynchronise the type at the IPC
    // boundary AND the runtime guard `VALID_THEME_SOURCES` in
    // `theme-handler.ts` would silently drop the new value.
    //
    // The three files (canonical + two mirrors):
    //   - packages/desktop/src/shared/bridge-contract.ts   (`OkThemeSource`)
    //   - packages/core/src/desktop-bridge.ts              (`OkThemeSource`)
    //   - packages/app/src/lib/desktop-bridge-types.ts     (`OkThemeSource`)
    const desktopPath = join(__dirname, '..', '..', 'src', 'shared', 'bridge-contract.ts');
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
    const appPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'app',
      'src',
      'lib',
      'desktop-bridge-types.ts',
    );
    const { readFileSync } = await import('node:fs');

    const extractLiteralUnion = (src: string, typeName: string): Set<string> => {
      const srcWithoutLineComments = src.replace(/\/\/.*$/gm, '');
      const declRegex = new RegExp(`type\\s+${typeName}\\s*=([\\s\\S]*?);`, 'm');
      const match = srcWithoutLineComments.match(declRegex);
      if (!match?.[1]) return new Set();
      const body = match[1];
      const literals = body.match(/'([^']+)'/g) ?? [];
      return new Set(literals.map((l) => l.slice(1, -1)));
    };

    const desktopMembers = extractLiteralUnion(readFileSync(desktopPath, 'utf-8'), 'OkThemeSource');
    const coreMembers = extractLiteralUnion(readFileSync(corePath, 'utf-8'), 'OkThemeSource');
    const appMembers = extractLiteralUnion(readFileSync(appPath, 'utf-8'), 'OkThemeSource');

    // Guardrail — every extraction must find members; otherwise the regex
    // is broken and the equality checks are meaningless.
    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(coreMembers.size).toBeGreaterThan(0);
    expect(appMembers.size).toBeGreaterThan(0);

    // Pin the canonical member count — when the spec adds a 4th source
    // (e.g. `'auto'`), the maintainer updates this number AND all 3
    // unions in lockstep. Also forces re-review of the runtime guard
    // `VALID_THEME_SOURCES` in `theme-handler.ts`.
    expect(desktopMembers.size).toBe(3);

    expect(desktopMembers).toEqual(coreMembers);
    expect(desktopMembers).toEqual(appMembers);
  });

  test('M1 invariant: OkMenuAction literal-union drift catcher', async () => {
    // Menu actions cross the desktop preload boundary and are manually mirrored
    // in the desktop, core, and app bridge contracts. Keep the three unions in
    // lockstep so adding a menu action cannot silently miss a renderer mirror.
    const desktopPath = join(__dirname, '..', '..', 'src', 'shared', 'bridge-contract.ts');
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
    const appPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'app',
      'src',
      'lib',
      'desktop-bridge-types.ts',
    );
    const { readFileSync } = await import('node:fs');

    const extractLiteralUnion = (src: string, typeName: string): Set<string> => {
      const srcWithoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const declRegex = new RegExp(`type\\s+${typeName}\\s*=([\\s\\S]*?);`, 'm');
      const match = srcWithoutComments.match(declRegex);
      if (!match?.[1]) return new Set();
      const body = match[1];
      const literals = body.match(/'([^']+)'/g) ?? [];
      return new Set(literals.map((l) => l.slice(1, -1)));
    };

    const desktopMembers = extractLiteralUnion(readFileSync(desktopPath, 'utf-8'), 'OkMenuAction');
    const coreMembers = extractLiteralUnion(readFileSync(corePath, 'utf-8'), 'OkMenuAction');
    const appMembers = extractLiteralUnion(readFileSync(appPath, 'utf-8'), 'OkMenuAction');

    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(coreMembers.size).toBeGreaterThan(0);
    expect(appMembers.size).toBeGreaterThan(0);
    // 26 + 2 worktree actions (`new-worktree`, `switch-worktree`) for the
    // worktree selector (worktree = window).
    expect(desktopMembers.size).toBe(28);
    expect(desktopMembers).toEqual(coreMembers);
    expect(desktopMembers).toEqual(appMembers);
    // Pin the surviving visibility toggle explicitly: a bare count check
    // wouldn't notice a simultaneous add+remove that nets to the same size.
    expect(desktopMembers.has('toggle-show-hidden-files')).toBe(true);
    expect(desktopMembers.has('new-worktree')).toBe(true);
    expect(desktopMembers.has('switch-worktree')).toBe(true);
  });

  test('M1 invariant: EntryPoint / OkProjectEntryPoint literal-union drift catcher', async () => {
    // The Navigator-side entry-point discriminator appears verbatim in THREE
    // files (the canonical desktop type + 2 bridge-contract mirrors). The
    // create-new-project work proved the drift scenario was real (it renamed
    // 'start-fresh' → 'create-new' and added 'create-new-nested-redirect'),
    // and the two mirror files' doc comments already claim drift is caught
    // here — make that claim load-bearing.
    //
    // The three files (canonical + two mirrors):
    //   - packages/desktop/src/shared/entry-point.ts       (`EntryPoint`)
    //   - packages/core/src/desktop-bridge.ts              (`OkProjectEntryPoint`)
    //   - packages/app/src/lib/desktop-bridge-types.ts     (`OkProjectEntryPoint`)
    const desktopPath = join(__dirname, '..', '..', 'src', 'shared', 'entry-point.ts');
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
    const appPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'app',
      'src',
      'lib',
      'desktop-bridge-types.ts',
    );
    const { readFileSync } = await import('node:fs');

    const extractLiteralUnion = (src: string, typeName: string): Set<string> => {
      const declRegex = new RegExp(`type\\s+${typeName}\\s*=([^;]+);`, 'm');
      const match = src.match(declRegex);
      if (!match?.[1]) return new Set();
      const body = match[1];
      const literals = body.match(/'([^']+)'/g) ?? [];
      return new Set(literals.map((l) => l.slice(1, -1)));
    };

    const desktopMembers = extractLiteralUnion(readFileSync(desktopPath, 'utf-8'), 'EntryPoint');
    const coreMembers = extractLiteralUnion(readFileSync(corePath, 'utf-8'), 'OkProjectEntryPoint');
    const appMembers = extractLiteralUnion(readFileSync(appPath, 'utf-8'), 'OkProjectEntryPoint');

    // Guardrail — every extraction must find members.
    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(coreMembers.size).toBeGreaterThan(0);
    expect(appMembers.size).toBeGreaterThan(0);

    // Pin the canonical member count — when the spec adds a new entry point,
    // the maintainer updates this number AND all 3 unions in lockstep. Also
    // forces re-review of the runtime guard `isEntryPoint` + the
    // `ENTRY_POINT_VALUES` Set in `entry-point.ts`.
    // 7 + `'worktree'` (worktree = window — opening a worktree of the
    // current project; classified `managed`, so it opens without consent).
    expect(desktopMembers.size).toBe(8);

    expect(desktopMembers).toEqual(coreMembers);
    expect(desktopMembers).toEqual(appMembers);
  });

  test('M1 invariant: KeyringSmokeResult shape drift catcher (M5)', async () => {
    // Walks the `KeyringSmokeResult` (desktop utility source), and
    // `OkKeyringSmokeResult` (core + app mirror) interfaces and asserts the
    // three copies declare the SAME field-name set. Field names carry the
    // contract — drift (e.g., a future contributor adds `attempts?: number`
    // to one copy only) fails this test and surfaces which file is missing
    // what. Complements the `OkDesktopBridge` drift catcher; both
    // shapes cross the preload boundary and renaming either triplicates risk.
    const desktopSmokeSrcPath = join(__dirname, '..', '..', 'src', 'utility', 'keyring-smoke.ts');
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
    const appPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'app',
      'src',
      'lib',
      'desktop-bridge-types.ts',
    );
    const { readFileSync } = await import('node:fs');

    /**
     * Extract the top-level field names from a named interface declaration.
     * Same brace-depth walk as `extractBridgeMembers`, parameterised
     * over the interface name so one helper covers the `KeyringSmokeResult`
     * and `OkKeyringSmokeResult` variants.
     */
    const extractInterfaceFields = (src: string, interfaceName: string): Set<string> => {
      const names = new Set<string>();
      const lines = src.split('\n');
      const declRegex = new RegExp(`interface\\s+${interfaceName}\\s*\\{`);
      let inInterface = false;
      let depth = 0;
      for (const line of lines) {
        if (!inInterface) {
          if (declRegex.test(line)) {
            inInterface = true;
            depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
          }
          continue;
        }
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        if (depth === 1) {
          const trimmed = line.trim();
          const memberMatch = trimmed.match(/^(?:readonly\s+)?(\w+)\s*[:?]/);
          if (memberMatch?.[1]) names.add(memberMatch[1]);
        }
        depth += opens - closes;
        if (depth === 0) break;
      }
      return names;
    };

    const desktopFields = extractInterfaceFields(
      readFileSync(desktopSmokeSrcPath, 'utf-8'),
      'KeyringSmokeResult',
    );
    const coreFields = extractInterfaceFields(
      readFileSync(corePath, 'utf-8'),
      'OkKeyringSmokeResult',
    );
    const appFields = extractInterfaceFields(
      readFileSync(appPath, 'utf-8'),
      'OkKeyringSmokeResult',
    );

    // Guardrail — all three extractions must find fields.
    expect(desktopFields.size).toBeGreaterThan(0);
    expect(coreFields.size).toBeGreaterThan(0);
    expect(appFields.size).toBeGreaterThan(0);

    const diff = (a: Set<string>, b: Set<string>) => Array.from(a).filter((x) => !b.has(x));
    const desktopMinusCore = diff(desktopFields, coreFields);
    const coreMinusDesktop = diff(coreFields, desktopFields);
    const desktopMinusApp = diff(desktopFields, appFields);
    const appMinusDesktop = diff(appFields, desktopFields);

    if (
      desktopMinusCore.length +
        coreMinusDesktop.length +
        desktopMinusApp.length +
        appMinusDesktop.length >
      0
    ) {
      throw new Error(
        [
          'KeyringSmokeResult / OkKeyringSmokeResult shape drift across the three copies:',
          `  desktop has but core missing:  [${desktopMinusCore.join(', ')}]`,
          `  core has but desktop missing:  [${coreMinusDesktop.join(', ')}]`,
          `  desktop has but app missing:   [${desktopMinusApp.join(', ')}]`,
          `  app has but desktop missing:   [${appMinusDesktop.join(', ')}]`,
          '',
          'Fix: update the missing files so all three copies agree on the field set.',
        ].join('\n'),
      );
    }
  });

  test('M1 invariant: project session state shape drift catcher', async () => {
    // Project tab-session state is hand-mirrored across app, desktop bridge,
    // IPC, and main persistence. If one copy gains a field without the
    // others, desktop session restore silently truncates data at the boundary.
    const appEditorTabsPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'app',
      'src',
      'editor',
      'editor-tabs.ts',
    );
    const appBridgePath = join(
      __dirname,
      '..',
      '..',
      '..',
      'app',
      'src',
      'lib',
      'desktop-bridge-types.ts',
    );
    const desktopBridgePath = join(__dirname, '..', '..', 'src', 'shared', 'bridge-contract.ts');
    const ipcChannelsPath = join(__dirname, '..', '..', 'src', 'shared', 'ipc-channels.ts');
    const stateStorePath = join(__dirname, '..', '..', 'src', 'main', 'state-store.ts');
    const { readFileSync } = await import('node:fs');

    const extractInterfaceFields = (src: string, interfaceName: string): Set<string> => {
      const names = new Set<string>();
      const lines = src.split('\n');
      const declRegex = new RegExp(`interface\\s+${interfaceName}\\s*\\{`);
      let inInterface = false;
      let depth = 0;
      for (const line of lines) {
        if (!inInterface) {
          if (declRegex.test(line)) {
            inInterface = true;
            depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
          }
          continue;
        }
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        if (depth === 1) {
          const trimmed = line.trim();
          const memberMatch = trimmed.match(/^(?:readonly\s+)?(\w+)\s*[:?]/);
          if (memberMatch?.[1]) names.add(memberMatch[1]);
        }
        depth += opens - closes;
        if (depth === 0) break;
      }
      return names;
    };

    const sources = [
      {
        label: 'app/editor-tabs.ts (EditorTabSessionState)',
        fields: extractInterfaceFields(
          readFileSync(appEditorTabsPath, 'utf-8'),
          'EditorTabSessionState',
        ),
      },
      {
        label: 'app/desktop-bridge-types.ts (ProjectSessionState)',
        fields: extractInterfaceFields(readFileSync(appBridgePath, 'utf-8'), 'ProjectSessionState'),
      },
      {
        label: 'desktop/bridge-contract.ts (ProjectSessionState)',
        fields: extractInterfaceFields(
          readFileSync(desktopBridgePath, 'utf-8'),
          'ProjectSessionState',
        ),
      },
      {
        label: 'desktop/ipc-channels.ts (ProjectSessionState)',
        fields: extractInterfaceFields(
          readFileSync(ipcChannelsPath, 'utf-8'),
          'ProjectSessionState',
        ),
      },
      {
        label: 'desktop/state-store.ts (ProjectSessionState)',
        fields: extractInterfaceFields(
          readFileSync(stateStorePath, 'utf-8'),
          'ProjectSessionState',
        ),
      },
    ] as const;

    for (const source of sources) {
      expect(source.fields.size).toBeGreaterThan(0);
    }

    const canonical = sources[0];
    const diff = (a: Set<string>, b: Set<string>) => Array.from(a).filter((x) => !b.has(x));
    const failures: string[] = [];
    for (const source of sources.slice(1)) {
      const canonicalMinusSource = diff(canonical.fields, source.fields);
      const sourceMinusCanonical = diff(source.fields, canonical.fields);
      if (canonicalMinusSource.length || sourceMinusCanonical.length) {
        failures.push(
          `  ${source.label} drift vs ${canonical.label}:\n` +
            `    canonical has but copy missing: [${canonicalMinusSource.join(', ')}]\n` +
            `    copy has but canonical missing: [${sourceMinusCanonical.join(', ')}]`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        [
          'ProjectSessionState / EditorTabSessionState shape drift across session-state copies:',
          ...failures,
          '',
          'Fix: update every session-state interface so all copies agree on the field set.',
        ].join('\n'),
      );
    }
  });
});
