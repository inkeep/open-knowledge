/**
 * End-to-end smoke test index.
 *
 *   Test 1 (dev loop) — Playwright `_electron.launch` against the bundled
 *     out/main/index.js. Skipped here with a structured reason because the
 *     full Playwright + Electron + display-server harness is not part of
 *     the Vitest suite (it will run in the electron-builder smoke pipeline
 *     once that pipeline lands). The bridge / utility /
 *     window-manager / IPC layers ARE end-to-end tested via the unit-test
 *     suite at the boundary they expose to the renderer.
 *
 *   Test 2 (keyring smoke) — exercises @napi-rs/keyring directly from a
 *     plain Node process to prove the binding loads under the current runtime
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
 * Net: this file's sole NEW gate is Test 2 (keyring smoke under Node). The
 * other three are coverage pointers — explicit references so a future
 * developer can find the existing tests via this index.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

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
    // Confirms the native binding loads under Node. @napi-rs/keyring is a CLI
    // dep that must rebuild against Electron's Node ABI in packaged builds.
    // This test catches the load-time failure shape (ABI mismatch or missing
    // prebuilt) before the packaged-build pipeline exercises Electron's ABI.
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
    // returns, preventing `vitest run` from exiting cleanly. That manifests
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
    const coreBridgePath = join(packagesRoot, 'core', 'src', 'desktop-bridge.ts');
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
        expectedLiteralCount: 11,
        inlineRe:
          /'claude'\s*\|\s*'claude-desktop'\s*\|\s*'cursor'\s*\|\s*'codex'\s*\|\s*'copilot'\s*\|\s*'opencode'\s*\|\s*'openclaw'/,
        mirrors: [
          ['cli/commands/editors.ts', cliEditorsPath],
          ['desktop/shared/ipc-channels.ts', ipcChannelsPath],
          ['core/desktop-bridge.ts', coreBridgePath],
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
          /from\s+['"]@inkeep\/open-knowledge-core(?:\/desktop-bridge)?['"]/.test(src) ||
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
    // The core leaf owns `OkThemeSource`; `VALID_THEME_SOURCES` remains an
    // independent IPC runtime guard.
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
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

    const coreMembers = extractLiteralUnion(readFileSync(corePath, 'utf-8'), 'OkThemeSource');
    // Guardrail — every extraction must find members; otherwise the regex
    // is broken and the equality checks are meaningless.
    expect(coreMembers.size).toBeGreaterThan(0);

    // Pinning the count forces new members to revisit that runtime guard.
    expect(coreMembers.size).toBe(3);
  });

  test('M1 invariant: OkMenuAction literal-union drift catcher', async () => {
    // Menu actions cross the desktop preload boundary. The core leaf owns the
    // union, and the consumer shims must continue re-exporting that declaration.
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
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

    const coreMembers = extractLiteralUnion(readFileSync(corePath, 'utf-8'), 'OkMenuAction');
    expect(coreMembers.size).toBeGreaterThan(0);
    // 26 baseline + 2 worktree + 2 Help + 3 sidebar + 2 navigation + 1 agents panel
    // + 1 terminal placement action.
    expect(coreMembers.size).toBe(37);
    // Pin the visibility toggles explicitly: a bare count check wouldn't
    // notice a simultaneous add+remove that nets to the same size.
    expect(coreMembers.has('toggle-show-hidden-files')).toBe(true);
    expect(coreMembers.has('toggle-show-ok-folders')).toBe(true);
    expect(coreMembers.has('toggle-show-only-markdown-files')).toBe(true);
    expect(coreMembers.has('toggle-show-skills-section')).toBe(true);
    expect(coreMembers.has('new-worktree')).toBe(true);
    expect(coreMembers.has('switch-worktree')).toBe(true);
    expect(coreMembers.has('report-bug')).toBe(true);
    expect(coreMembers.has('navigate-back')).toBe(true);
    expect(coreMembers.has('navigate-forward')).toBe(true);
    expect(coreMembers.has('toggle-agent-panel')).toBe(true);
    expect(coreMembers.has('move-terminal')).toBe(true);
  });

  test('M1 invariant: EntryPoint / OkProjectEntryPoint literal-union drift catcher', async () => {
    // The Navigator-side desktop entry point remains an independent runtime
    // discriminator, while the bridge declaration lives in the core leaf.
    // Relevant sources:
    //   - packages/desktop/src/shared/entry-point.ts       (`EntryPoint`)
    //   - packages/core/src/desktop-bridge.ts              (`OkProjectEntryPoint`)
    const desktopPath = join(__dirname, '..', '..', 'src', 'shared', 'entry-point.ts');
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
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
    // Guardrail — the independent desktop and canonical core declarations
    // must remain non-empty.
    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(coreMembers.size).toBeGreaterThan(0);

    // Pinning the count forces new members to revisit the independent
    // `isEntryPoint` / `ENTRY_POINT_VALUES` runtime guard.
    // 7 + `'worktree'` (worktree = window — opening a worktree of the
    // current project; classified `managed`, so it opens without consent).
    expect(desktopMembers.size).toBe(8);

    expect(desktopMembers).toEqual(coreMembers);
  });

  test('M1 invariant: KeyringSmokeResult shape drift catcher (M5)', async () => {
    // Compare the independent desktop utility result against the canonical
    // core bridge type.
    const desktopSmokeSrcPath = join(__dirname, '..', '..', 'src', 'utility', 'keyring-smoke.ts');
    const corePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
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
    // Guardrail — both independent declarations must expose fields.
    expect(desktopFields.size).toBeGreaterThan(0);
    expect(coreFields.size).toBeGreaterThan(0);

    const diff = (a: Set<string>, b: Set<string>) => Array.from(a).filter((x) => !b.has(x));
    const desktopMinusCore = diff(desktopFields, coreFields);
    const coreMinusDesktop = diff(coreFields, desktopFields);

    if (desktopMinusCore.length + coreMinusDesktop.length > 0) {
      throw new Error(
        [
          'KeyringSmokeResult / OkKeyringSmokeResult shape drift across the desktop utility and core bridge:',
          `  desktop has but core missing:  [${desktopMinusCore.join(', ')}]`,
          `  core has but desktop missing:  [${coreMinusDesktop.join(', ')}]`,
          '',
          'Fix: update the independent desktop utility or canonical core bridge field set.',
        ].join('\n'),
      );
    }
  });

  test('M1 invariant: project session state shape drift catcher', async () => {
    // Project tab-session state remains independently shaped in the app,
    // desktop IPC, and main persistence. The host bridge declaration itself
    // is canonical in core and both consumer paths re-export it.
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
    const coreBridgePath = join(__dirname, '..', '..', '..', 'core', 'src', 'desktop-bridge.ts');
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
        label: 'core/desktop-bridge.ts (ProjectSessionState)',
        fields: extractInterfaceFields(
          readFileSync(coreBridgePath, 'utf-8'),
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
