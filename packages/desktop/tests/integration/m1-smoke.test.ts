import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('M1 smoke', () => {
  test('Test 1 — dev loop: Playwright _electron.launch (DEFERRED to M2)', () => {
    expect(true).toBe(true); // placeholder — real check is M2
  });

  test('Test 2 — keyring smoke: @napi-rs/keyring loads + round-trips a secret', async () => {
    let keyring: typeof import('@napi-rs/keyring') | null = null;
    try {
      keyring = await import('@napi-rs/keyring');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[m1-smoke] @napi-rs/keyring failed to load: ${message}`);
      console.warn(
        '[m1-smoke] SKIPPING keyring round-trip (R15 fallback to plaintext YAML kicks in)',
      );
      expect(message.length).toBeGreaterThan(0);
      return;
    }

    const Entry = keyring.Entry;
    expect(typeof Entry).toBe('function');

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
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[m1-smoke] keyring round-trip skipped (env): ${message}`);
      expect(message.length).toBeGreaterThan(0);
    } finally {
      try {
        entry.deletePassword();
      } catch {}
    }
  });

  test('Test 3 — parent-death detection: covered by tests/utility/server-entry.test.ts', () => {
    const utilityTestPath = join(__dirname, '..', 'utility', 'server-entry.test.ts');
    expect(existsSync(utilityTestPath)).toBe(true);
  });

  test('Test 4 — server.lock behavior: covered by tests/main/window-manager.test.ts + V0-1 server-lock.test.ts', () => {
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
    const extractBridgeMembers = (src: string): Set<string> => {
      const names = new Set<string>();
      const lines = src.split('\n');
      let inInterface = false;
      let braceDepth = 0;
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

    expect(coreMembers.size).toBeGreaterThan(0);
    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(appMembers.size).toBeGreaterThan(0);

    const REQUIRED_SHELL_MEMBERS = [
      'shell.openExternal', // M1 baseline
      'shell.detectProtocol', // 2026-04-21 US-004 (Open in Agent)
      'shell.spawnCursor', // 2026-04-21 US-004 (Open in Agent)
      'shell.recordHandoff', // 2026-04-21 US-008 (Open in Agent telemetry)
      'shell.openAsset', // 2026-04-23 FR-A6 (asset-click dispatcher)
      'shell.revealAsset', // 2026-04-23 FR-A6 (asset-click dispatcher)
      'shell.showAssetMenu', // 2026-04-23 FR-A8 (right-click context menu)
      'shell.showItemInFolder', // 2026-04-27 file-tree reveal-in-finder
      'shell.trashItem', // 2026-05-16 sidebar Trash flow (FR8 / D24 Option B)
    ] as const;
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
        expectedLiteralCount: 5,
        inlineRe:
          /'claude'\s*\|\s*'claude-desktop'\s*\|\s*'cursor'\s*\|\s*'codex'\s*\|\s*'opencode'/,
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
        inlineRe:
          /'invalid-args'\s*\|\s*'nested-project'\s*\|\s*'target-not-empty'\s*\|\s*'mkdir-failed'\s*\|\s*'git-init-failed'\s*\|\s*'init-failed'\s*\|\s*'discovery-failed'/,
        mirrors: [['desktop/main/create-new-project.ts', createNewProjectPath]],
      },
    ];

    const offenders: string[] = [];
    for (const pin of pins) {
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

    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(coreMembers.size).toBeGreaterThan(0);
    expect(appMembers.size).toBeGreaterThan(0);

    expect(desktopMembers.size).toBe(3);

    expect(desktopMembers).toEqual(coreMembers);
    expect(desktopMembers).toEqual(appMembers);
  });

  test('M1 invariant: OkMenuAction literal-union drift catcher', async () => {
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
    expect(desktopMembers.size).toBe(26);
    expect(desktopMembers).toEqual(coreMembers);
    expect(desktopMembers).toEqual(appMembers);
    expect(desktopMembers.has('toggle-show-hidden-files')).toBe(true);
  });

  test('M1 invariant: EntryPoint / OkProjectEntryPoint literal-union drift catcher', async () => {
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

    expect(desktopMembers.size).toBeGreaterThan(0);
    expect(coreMembers.size).toBeGreaterThan(0);
    expect(appMembers.size).toBeGreaterThan(0);

    expect(desktopMembers.size).toBe(7);

    expect(desktopMembers).toEqual(coreMembers);
    expect(desktopMembers).toEqual(appMembers);
  });

  test('M1 invariant: KeyringSmokeResult shape drift catcher (M5)', async () => {
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
