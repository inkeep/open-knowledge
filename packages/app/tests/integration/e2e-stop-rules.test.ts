/**
 * Selection-halo chrome comes from plugin state and never from the `:has()` cascade, and this
 * suite is the mechanical guard for that ban (precedent #34).
 */

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CallExpression,
  type Diagnostic,
  type Node,
  type ObjectLiteralExpression,
  Project,
  SyntaxKind,
} from 'ts-morph';
import { describe, expect, test } from 'vitest';
import { DEV_GATED_WINDOW_WRITERS } from './dev-gate-allowlist';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const E2E_DIRS = [
  join(__dirname, '..', 'stress'),
  join(__dirname, '..', 'visual'),
  join(__dirname, '..', 'a11y'),
];
const APP_SRC_DIR = join(__dirname, '..', '..', 'src');

interface FileLines {
  path: string;
  absPath: string;
  source: string;
  lines: string[];
}

const unreadableScanDirs: string[] = [];

function listE2eTsFiles(): FileLines[] {
  const out: FileLines[] = [];
  function walk(dir: string) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      unreadableScanDirs.push(`${relative(REPO_ROOT, dir)} (${reason})`);
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts')) continue;
      const source = readFileSync(abs, 'utf-8');
      out.push({
        path: relative(REPO_ROOT, abs),
        absPath: abs,
        source,
        lines: source.split('\n'),
      });
    }
  }
  for (const dir of E2E_DIRS) walk(dir);
  return out;
}

function listAppSrcTsFiles(): FileLines[] {
  const out: FileLines[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name);
      if (name.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!name.isFile()) continue;
      if (!name.name.endsWith('.ts') && !name.name.endsWith('.tsx')) continue;
      if (name.name.endsWith('.test.ts') || name.name.endsWith('.test.tsx')) continue;
      if (name.name.endsWith('.spec.ts') || name.name.endsWith('.spec.tsx')) continue;
      const source = readFileSync(abs, 'utf-8');
      out.push({
        path: relative(REPO_ROOT, abs),
        absPath: abs,
        source,
        lines: source.split('\n'),
      });
    }
  }
  walk(APP_SRC_DIR);
  return out;
}

const SPAWN_REQUIRED_ENV_KEYS = ['OK_TEST_VITE_CACHE_DIR', 'OK_TEST_SKIP_I18N_COMPILE'] as const;
type RequiredSpawnEnvKey = (typeof SPAWN_REQUIRED_ENV_KEYS)[number];
const SPAWN_CALLEE_NAMES = new Set(['spawn', 'spawnSync']);
const DEV_SERVER_ARGV_TOKEN = 'dev';
const PARENT_ENV_SPREAD = 'process.env';
const CHILD_PROCESS_CALL_PATTERN =
  /(?<![\w$])(?:spawnSync|spawn|execFileSync|execFile|execSync|fork)\s*\(|(?<![.\w$])exec\s*\(/;
const MIRROR_EXCLUDED_INFIX = '.private.';
const DEV_SERVER_SPAWN_SITES = [
  'packages/app/tests/stress/_helpers/fixtures.ts',
  'packages/app/tests/stress/_helpers/global-warm-cache.ts',
] as const;
const NON_DEV_SERVER_SPAWN_SITES = [
  'packages/app/tests/stress/_helpers/i18n-catalog-freshness.ts',
  'packages/app/tests/stress/okf-generated-index-settings.e2e.ts',
] as const;
const PINNED_SPAWN_SITES = [...DEV_SERVER_SPAWN_SITES, ...NON_DEV_SERVER_SPAWN_SITES].sort();

function isMirrorExcluded(path: string): boolean {
  return path.includes(MIRROR_EXCLUDED_INFIX);
}

function mirroredFilesWithChildProcessCalls(files: FileLines[]): string[] {
  const out = new Set<string>();
  for (const file of files) {
    if (isMirrorExcluded(file.path)) continue;
    if (file.lines.some((line) => CHILD_PROCESS_CALL_PATTERN.test(line))) out.add(file.path);
  }
  return [...out].sort();
}

type SpawnIsolationViolation =
  | { line: number; reason: 'missing-key'; missingKey: RequiredSpawnEnvKey }
  | {
      line: number;
      reason: 'unconfirmed-key';
      unconfirmedKey: RequiredSpawnEnvKey;
      detail: string;
    }
  | { line: number; reason: 'cleared-key'; clearedKey: RequiredSpawnEnvKey }
  | { line: number; reason: 'undeterminable'; detail: string };

interface SpawnIsolationScan {
  devServerSpawnLines: number[];
  violations: SpawnIsolationViolation[];
}

type EnvKeyVerdict =
  | { kind: 'declared' }
  | { kind: 'shadowed'; spread: string }
  | { kind: 'cleared' };

type SpawnEnvResolution =
  | {
      kind: 'keys';
      keys: ReadonlyMap<string, EnvKeyVerdict>;
      unreadableSpread: string | null;
    }
  | { kind: 'undeterminable'; detail: string };

const spawnScanProject = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  skipLoadingLibFiles: true,
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { noLib: true, allowJs: false },
});

function excerpt(node: Node): string {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function diagnosticText(diagnostic: Diagnostic): string {
  const message = diagnostic.getMessageText();
  return typeof message === 'string' ? message : message.getMessageText();
}

function stringLiteralValue(node: Node): string | null {
  if (node.isKind(SyntaxKind.StringLiteral)) return node.getLiteralValue();
  if (node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) return node.getLiteralValue();
  return null;
}

function propertyKey(nameNode: Node): string | null {
  const literal = stringLiteralValue(nameNode);
  if (literal !== null) return literal;
  if (nameNode.isKind(SyntaxKind.Identifier)) return nameNode.getText();
  if (nameNode.isKind(SyntaxKind.NumericLiteral)) return nameNode.getText();
  if (nameNode.isKind(SyntaxKind.ComputedPropertyName)) {
    return stringLiteralValue(nameNode.getExpression());
  }
  return null;
}

function isDevServerArgvToken(node: Node): boolean {
  return stringLiteralValue(node) === DEV_SERVER_ARGV_TOKEN;
}

function isDevServerSpawnCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  const name = callee.isKind(SyntaxKind.PropertyAccessExpression)
    ? callee.getName()
    : callee.getText();
  if (!SPAWN_CALLEE_NAMES.has(name)) return false;
  for (const arg of call.getArguments()) {
    if (arg.isKind(SyntaxKind.ObjectLiteralExpression)) break;
    if (isDevServerArgvToken(arg)) return true;
    if (
      arg.isKind(SyntaxKind.ArrayLiteralExpression) &&
      arg.getElements().some(isDevServerArgvToken)
    ) {
      return true;
    }
  }
  return false;
}

function resolvesToUndefined(node: Node | undefined): boolean {
  if (node === undefined) return false;
  if (node.isKind(SyntaxKind.VoidExpression)) return true;
  return node.isKind(SyntaxKind.Identifier) && node.getText() === 'undefined';
}

function envKeysFromLiteral(env: ObjectLiteralExpression): SpawnEnvResolution {
  const keys = new Map<string, EnvKeyVerdict>();
  let unreadableSpread: string | null = null;
  for (const prop of env.getProperties()) {
    if (prop.isKind(SyntaxKind.SpreadAssignment)) {
      const spread = prop.getExpression();
      const spreadText = excerpt(spread);
      if (spread.getText() !== PARENT_ENV_SPREAD) unreadableSpread ??= spreadText;
      for (const key of keys.keys()) keys.set(key, { kind: 'shadowed', spread: spreadText });
      continue;
    }
    if (prop.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
      keys.set(prop.getName(), { kind: 'declared' });
      continue;
    }
    if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue;
    const key = propertyKey(prop.getNameNode());
    if (key === null) {
      return {
        kind: 'undeterminable',
        detail: `its \`env\` object has the computed key \`${excerpt(prop.getNameNode())}\`, which may or may not be an isolation key`,
      };
    }
    keys.set(
      key,
      resolvesToUndefined(prop.getInitializer()) ? { kind: 'cleared' } : { kind: 'declared' },
    );
  }
  return { kind: 'keys', keys, unreadableSpread };
}

function envKeysFromOptions(options: ObjectLiteralExpression): SpawnEnvResolution {
  const props = options.getProperties();
  let env: ObjectLiteralExpression | null = null;
  let envIndex = -1;
  for (const [index, prop] of props.entries()) {
    if (prop.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
      if (prop.getName() !== 'env') continue;
      return {
        kind: 'undeterminable',
        detail:
          'its options object passes `env` by shorthand (`{ env }`), so the env object is built elsewhere and is not readable at this call',
      };
    }
    if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue;
    const key = propertyKey(prop.getNameNode());
    if (key === null) {
      return {
        kind: 'undeterminable',
        detail: `its options object has the computed key \`${excerpt(prop.getNameNode())}\`, which may or may not be \`env\``,
      };
    }
    if (key !== 'env') continue;
    const initializer = prop.getInitializer();
    if (initializer === undefined || !initializer.isKind(SyntaxKind.ObjectLiteralExpression)) {
      return {
        kind: 'undeterminable',
        detail: `its \`env\` is \`${excerpt(initializer ?? prop)}\`, not an object literal, so the keys it carries are not readable at this call`,
      };
    }
    env = initializer;
    envIndex = index;
  }
  if (env === null) {
    if (props.some((prop) => prop.isKind(SyntaxKind.SpreadAssignment))) {
      return {
        kind: 'undeterminable',
        detail:
          'its options object declares no own `env` and spreads another object, which may carry one',
      };
    }
    return { kind: 'keys', keys: new Map(), unreadableSpread: null };
  }
  if (props.slice(envIndex + 1).some((prop) => prop.isKind(SyntaxKind.SpreadAssignment))) {
    return {
      kind: 'undeterminable',
      detail:
        'its options object spreads another object after `env`, which may replace the env read here',
    };
  }
  return envKeysFromLiteral(env);
}

function resolveSpawnEnv(call: CallExpression): SpawnEnvResolution {
  const lastArg = call.getArguments().at(-1);
  if (lastArg === undefined) return { kind: 'keys', keys: new Map(), unreadableSpread: null };
  if (lastArg.isKind(SyntaxKind.ObjectLiteralExpression)) return envKeysFromOptions(lastArg);
  if (stringLiteralValue(lastArg) !== null || lastArg.isKind(SyntaxKind.ArrayLiteralExpression)) {
    return { kind: 'keys', keys: new Map(), unreadableSpread: null };
  }
  return {
    kind: 'undeterminable',
    detail: `its last argument is \`${excerpt(lastArg)}\` (${lastArg.getKindName()}), so the guard cannot tell whether it is an argv list or an options object carrying an env`,
  };
}

function assertNeverEnvKeyVerdict(verdict: never): never {
  throw new Error(`Unhandled EnvKeyVerdict kind: ${JSON.stringify(verdict)}`);
}

function scanSpawnIsolation(name: string, source: string): SpawnIsolationScan {
  const sourceFile = spawnScanProject.createSourceFile(`/${name}`, source, { overwrite: true });
  const syntaxError = spawnScanProject.getProgram().getSyntacticDiagnostics(sourceFile)[0];
  if (syntaxError !== undefined) {
    return {
      devServerSpawnLines: [],
      violations: [
        {
          line: syntaxError.getLineNumber() ?? 1,
          reason: 'undeterminable',
          detail: `the file does not parse (${diagnosticText(syntaxError)}), so no spawn call in it can be read`,
        },
      ],
    };
  }

  const devServerSpawnLines: number[] = [];
  const violations: SpawnIsolationViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isDevServerSpawnCall(call)) continue;
    const line = call.getStartLineNumber();
    devServerSpawnLines.push(line);
    const env = resolveSpawnEnv(call);
    if (env.kind === 'undeterminable') {
      violations.push({ line, reason: 'undeterminable', detail: env.detail });
      continue;
    }
    for (const key of SPAWN_REQUIRED_ENV_KEYS) {
      const verdict = env.keys.get(key);
      if (verdict === undefined) {
        if (env.unreadableSpread === null) {
          violations.push({ line, reason: 'missing-key', missingKey: key });
          continue;
        }
        violations.push({
          line,
          reason: 'unconfirmed-key',
          unconfirmedKey: key,
          detail: `the \`env\` object spreads \`${env.unreadableSpread}\`, which may carry it`,
        });
        continue;
      }
      switch (verdict.kind) {
        case 'declared':
          continue;
        case 'shadowed':
          violations.push({
            line,
            reason: 'unconfirmed-key',
            unconfirmedKey: key,
            detail: `the \`env\` object declares it and then spreads \`${verdict.spread}\`, which may replace it`,
          });
          continue;
        case 'cleared':
          violations.push({ line, reason: 'cleared-key', clearedKey: key });
          continue;
        default:
          assertNeverEnvKeyVerdict(verdict);
      }
    }
  }
  return { devServerSpawnLines, violations };
}

const spawnScanCache = new Map<string, SpawnIsolationScan>();

function scanFileSpawnIsolation(file: FileLines): SpawnIsolationScan {
  const cached = spawnScanCache.get(file.path);
  if (cached !== undefined) return cached;
  const scan = scanSpawnIsolation(file.path, file.source);
  spawnScanCache.set(file.path, scan);
  return scan;
}

let plantedSpawnScanSeq = 0;

function scanPlantedSpawnIsolation(lines: string[]): SpawnIsolationScan {
  plantedSpawnScanSeq += 1;
  return scanSpawnIsolation(`planted-${plantedSpawnScanSeq}.ts`, lines.join('\n'));
}

function assertNeverSpawnViolation(violation: never): never {
  throw new Error(`Unhandled SpawnIsolationViolation reason: ${JSON.stringify(violation)}`);
}

function describeSpawnViolation(violation: SpawnIsolationViolation): string {
  switch (violation.reason) {
    case 'missing-key':
      return `no ${violation.missingKey} in this spawn's own env option`;
    case 'unconfirmed-key':
      return `the guard could not establish that ${violation.unconfirmedKey} reaches the child process: ${violation.detail}, so it is unconfirmed rather than known-absent`;
    case 'cleared-key':
      return `this spawn's env option declares ${violation.clearedKey} as \`undefined\`, and Node ignores undefined values in \`env\`, so the key does not reach the child`;
    case 'undeterminable':
      return `this spawn's env could not be determined, so the isolation keys are unconfirmed rather than known-absent: ${violation.detail}`;
    default:
      return assertNeverSpawnViolation(violation);
  }
}

function missingKeysOf(scan: SpawnIsolationScan): RequiredSpawnEnvKey[] {
  return scan.violations
    .filter((violation) => violation.reason === 'missing-key')
    .map((violation) => violation.missingKey)
    .sort();
}

function unconfirmedKeysOf(scan: SpawnIsolationScan): RequiredSpawnEnvKey[] {
  return scan.violations
    .filter((violation) => violation.reason === 'unconfirmed-key')
    .map((violation) => violation.unconfirmedKey)
    .sort();
}

function clearedKeysOf(scan: SpawnIsolationScan): RequiredSpawnEnvKey[] {
  return scan.violations
    .filter((violation) => violation.reason === 'cleared-key')
    .map((violation) => violation.clearedKey)
    .sort();
}

function undeterminableDetails(scan: SpawnIsolationScan): string[] {
  return scan.violations
    .filter((violation) => violation.reason === 'undeterminable')
    .map((violation) => violation.detail);
}

function mirroredFilesWithDevServerSpawns(files: FileLines[]): string[] {
  return files
    .filter((file) => !isMirrorExcluded(file.path))
    .filter((file) => scanFileSpawnIsolation(file).devServerSpawnLines.length > 0)
    .map((file) => file.path)
    .sort();
}

function requirePinnedSpawnFile(files: FileLines[], path: string): FileLines {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(
      `${path} is pinned in DEV_SERVER_SPAWN_SITES but is not under the scanned e2e directories — it moved or was renamed, so its dev-server spawn stopped being checked. Point the path literal in DEV_SERVER_SPAWN_SITES at where the file lives now, and add its new parent to E2E_DIRS if the move left the scanned tree.`,
    );
  }
  return file;
}

function devServerSpawnCallHead(files: FileLines[], path: string): string {
  const file = requirePinnedSpawnFile(files, path);
  const line = scanFileSpawnIsolation(file).devServerSpawnLines[0];
  if (line === undefined) {
    throw new Error(
      `${path} is in the scanned corpus but the guard resolves no dev-server spawn call in it, so there is no real call head to harvest the fixture below from. Either the spawn moved — point DEV_SERVER_SPAWN_SITES at its new home — or the call-shape recogniser rotted: it selects a \`spawn\`/\`spawnSync\` call whose command or argv array carries the literal '${DEV_SERVER_ARGV_TOKEN}', so re-anchor SPAWN_CALLEE_NAMES and DEV_SERVER_ARGV_TOKEN on the shape this site now has.`,
    );
  }
  return file.lines[line - 1] ?? '';
}

function isRemoteImageHost(line: string): boolean {
  return /\b(picsum\.photos|images\.unsplash\.com|via\.placeholder\.com)\b/i.test(line);
}

function isStaticDevHarnessImport(line: string): boolean {
  return /^\s*(?:import|export)\s+(?!type\b)[^;]*from\s+['"][^'"]*dev-thread-harness['"]/.test(
    line,
  );
}

function collectMatches(
  files: FileLines[],
  predicate: (line: string, lineIdx: number, file: FileLines) => boolean,
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      if (predicate(file.lines[i] ?? '', i, file)) {
        violations.push(`  ${file.path}:${i + 1}    ${(file.lines[i] ?? '').trim()}`);
      }
    }
  }
  return violations;
}

describe('E2E STOP rule — zero allowlist', () => {
  const e2eTsFiles = listE2eTsFiles();
  const e2eFiles = e2eTsFiles.filter((file) => file.path.endsWith('.e2e.ts'));

  test('there are E2E files to check (sanity)', () => {
    expect(
      unreadableScanDirs,
      'a scan directory could not be read at any depth — the bans below would silently skip its files',
    ).toEqual([]);
    expect(e2eTsFiles.length).toBeGreaterThan(0);
    expect(e2eFiles.length).toBeGreaterThan(0);
    for (const dir of E2E_DIRS) {
      const tsFromDir = e2eTsFiles.filter((file) => file.absPath.startsWith(`${dir}/`));
      expect(
        tsFromDir.length,
        `no *.ts under ${relative(REPO_ROOT, dir)} — renamed, moved, or emptied?`,
      ).toBeGreaterThan(0);
      const fromDir = e2eFiles.filter((file) => file.absPath.startsWith(`${dir}/`));
      expect(
        fromDir.length,
        `no *.e2e.ts under ${relative(REPO_ROOT, dir)} — renamed, moved, or emptied?`,
      ).toBeGreaterThan(0);
    }
  });

  test('no page.waitForTimeout( in tests/{stress,visual,a11y}/*.e2e.ts (AC-3)', () => {
    const violations = collectMatches(e2eFiles, (line) => line.includes('page.waitForTimeout('));
    if (violations.length > 0) {
      throw new Error(
        `page.waitForTimeout( pattern found — replace with condition-based wait per D-Q1:\n${violations.join('\n')}`,
      );
    }
  });

  test("no waitUntil: 'networkidle' in tests/{stress,visual,a11y}/*.e2e.ts (AC-4)", () => {
    const violations = collectMatches(e2eFiles, (line) =>
      /waitUntil:\s*['"]networkidle['"]/.test(line),
    );
    if (violations.length > 0) {
      throw new Error(
        `waitUntil: 'networkidle' pattern found — use 'domcontentloaded' + waitForActiveProviderSynced instead:\n${violations.join('\n')}`,
      );
    }
  });

  test('no new Promise + setTimeout busy-wait in tests/{stress,visual,a11y}/*.e2e.ts (D-Q14)', () => {
    const pattern = /new Promise\(\s*(\w+)\s*=>\s*setTimeout\(\s*\1\s*,/;
    const violations = collectMatches(e2eFiles, (line) => pattern.test(line));
    if (violations.length > 0) {
      throw new Error(
        `\`new Promise(r => setTimeout(r, N))\` busy-wait found — use a condition-based wait:\n${violations.join('\n')}`,
      );
    }
  });

  test('no page.pause( in tests/{stress,visual,a11y}/*.e2e.ts (D-Q14)', () => {
    const violations = collectMatches(e2eFiles, (line) => line.includes('page.pause('));
    if (violations.length > 0) {
      throw new Error(
        `page.pause( found — debugger pauses must not land in committed E2E tests:\n${violations.join('\n')}`,
      );
    }
  });

  test("no test.skip(browserName === 'webkit') in tests/{stress,visual,a11y}/*.e2e.ts (AC-5 ratchet)", () => {
    const pattern = /test\.skip\(\s*browserName\s*===\s*['"]webkit['"]/;
    const violations = collectMatches(e2eFiles, (line) => pattern.test(line));
    if (violations.length > 0) {
      throw new Error(
        `webkit-skip pattern reintroduced — chromium-only CI ratchet (D-Q10):\n${violations.join('\n')}`,
      );
    }
  });

  test("no keyboard.press('Meta+X') — use ControlOrMeta+X for cross-platform CI (D-Q10)", () => {
    const pattern = /keyboard\.press\(\s*['"`]Meta\+[A-Za-z][A-Za-z]*['"`]/;
    const violations = collectMatches(e2eFiles, (line) => pattern.test(line));
    if (violations.length > 0) {
      throw new Error(
        `keyboard.press('Meta+X') — replace with 'ControlOrMeta+X' so CI (Linux chromium) maps to Ctrl+X:\n${violations.join('\n')}`,
      );
    }
  });

  test('no inner-file helper imports — must use barrel ./_helpers (D-Q11)', () => {
    const innerImport = /from\s+['"]\.\.?(?:\/[^'"]*)?\/_helpers\/[a-zA-Z][\w-]*['"]/;
    const violations = collectMatches(e2eFiles, (line) => innerImport.test(line));
    if (violations.length > 0) {
      throw new Error(
        `Inner-file helper import found — import from the barrel ('./_helpers') only:\n${violations.join('\n')}`,
      );
    }
  });

  test('no ungated window.__ writes outside dev-gate allowlist (US-006/US-026)', () => {
    const srcFiles = listAppSrcTsFiles();
    const writePattern = /window\.__[A-Za-z_][A-Za-z0-9_]*\s*=/;
    const equalityPattern = /window\.__[A-Za-z_][A-Za-z0-9_]*\s*===?/;
    const definePropertyPattern =
      /Object\.defineProperty\s*\(\s*window\s*,\s*['"]__[A-Za-z_][A-Za-z0-9_]*['"]/;

    const violations: string[] = [];
    for (const file of srcFiles) {
      if (DEV_GATED_WINDOW_WRITERS.includes(file.path)) continue;
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        const isAssignWrite = writePattern.test(line) && !equalityPattern.test(line);
        const isDefinePropertyWrite = definePropertyPattern.test(line);
        if (!isAssignWrite && !isDefinePropertyWrite) continue;
        violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Ungated window.__ write outside the dev-gate allowlist — wrap in if (import.meta.env.DEV) and add to dev-gate-allowlist.ts:\n${violations.join('\n')}`,
      );
    }
  });

  test('no static value import of the DEV ACP thread harness', () => {
    const violations = collectMatches(listAppSrcTsFiles(), (line) =>
      isStaticDevHarnessImport(line),
    );
    if (violations.length > 0) {
      throw new Error(
        `Static import of dev-thread-harness in app source — it must be reached only through the DEV-gated dynamic import:\n${violations.join('\n')}`,
      );
    }
  });

  test('no editor.mount( / editor.unmount( in V2 cache surfaces (precedent §25(a), SPEC US-001 Phase 1.0)', () => {
    const V2_CACHE_SURFACES = [
      join(APP_SRC_DIR, 'editor', 'editor-cache.ts'),
      join(APP_SRC_DIR, 'editor', 'TiptapEditor.tsx'),
    ];
    const pattern = /\beditor\.(mount|unmount)\s*\(/;
    const violations: string[] = [];
    for (const abs of V2_CACHE_SURFACES) {
      let source: string;
      try {
        source = readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!pattern.test(line)) continue;
        const trimmed = line.trim();
        if (
          trimmed.startsWith('*') ||
          trimmed.startsWith('//') ||
          trimmed.includes('`editor.mount(') ||
          trimmed.includes('`editor.unmount(')
        )
          continue;
        violations.push(`  ${relative(REPO_ROOT, abs)}:${i + 1}    ${trimmed}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `editor.mount()/unmount() call found in a V2-cache surface — use raw editor.editorView.dom reparent instead per precedent §25(a):\n${violations.join('\n')}`,
      );
    }
  });

  test('no waitForFunction(fn, { timeout/polling }) — options must be 3rd arg (precedent §20(j))', () => {
    const singleLinePattern = /waitForFunction\s*\([^)]*?=>\s*[^,]*,\s*\{\s*(timeout|polling)\s*:/;
    const multiLineKeyword = /^\s*\{\s*(timeout|polling)\s*:/;
    const fnBodyCloseTerminator = /\)\s*,\s*$/;

    const violations: string[] = [];
    for (const file of e2eFiles) {
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        if (singleLinePattern.test(line)) {
          violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
          continue;
        }
        if (!multiLineKeyword.test(line)) continue;
        let p = i - 1;
        while (p >= 0) {
          const prev = (file.lines[p] ?? '').trim();
          if (prev === '' || prev.startsWith('//') || prev.startsWith('*')) {
            p--;
            continue;
          }
          break;
        }
        if (p < 0) continue;
        const prev = file.lines[p] ?? '';
        if (!fnBodyCloseTerminator.test(prev)) continue;
        let scanUp = p;
        let foundCall = false;
        for (let k = 0; k < 10 && scanUp >= 0; k++, scanUp--) {
          if ((file.lines[scanUp] ?? '').includes('waitForFunction(')) {
            foundCall = true;
            break;
          }
        }
        if (!foundCall) continue;
        violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `waitForFunction(fn, { timeout/polling }) pattern — options as 2nd arg is bound to \`arg\` and silently ignored. Pass \`null\` as 2nd arg: \`waitForFunction(fn, null, { timeout: N })\`. See AGENTS.md §20(j):\n${violations.join('\n')}`,
      );
    }
  });

  test('e2e files that spawn a dev server must isolate shared mutable state (vite cache + i18n compile)', () => {
    const violations: string[] = [];
    for (const file of e2eTsFiles) {
      for (const violation of scanFileSpawnIsolation(file).violations) {
        violations.push(
          `  ${file.path}:${violation.line}    ${describeSpawnViolation(violation)}: ${(file.lines[violation.line - 1] ?? '').trim()}`,
        );
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `dev-server spawn without shared-state isolation — pass OK_TEST_VITE_CACHE_DIR (via prepareViteCacheDir from ./_helpers, removeAllDuringTeardown in teardown) and OK_TEST_SKIP_I18N_COMPILE: '1' in the spawn env. A line reported as unconfirmed rather than missing is one this guard could not settle: either it cannot read the spawn's env at all, so inline the env object at the call, or the key is absent from the env object's own properties while a spread may carry it, so declare the key at the call instead of leaving it to the spread, or the key is declared but a spread that follows it may replace it, so move the declaration after the last spread:\n${violations.join('\n')}`,
      );
    }
  });

  test('the spawn-isolation rule resolves a dev-server spawn in exactly the pinned sites', () => {
    expect(
      mirroredFilesWithDevServerSpawns(e2eTsFiles),
      'the files in which the guard resolves a dev-server spawn are no longer exactly the pinned dev-server spawn sites. Four causes, four different edits. (1) A pinned file moved or was renamed: update its path literal in DEV_SERVER_SPAWN_SITES, and add its new parent to E2E_DIRS if the move left the scanned tree — editing the call-shape recogniser will not bring it back. (2) The recogniser rotted against a call the corpus really has: it selects a `spawn`/`spawnSync` CallExpression whose command or argv array carries the literal argv token, so re-anchor SPAWN_CALLEE_NAMES and DEV_SERVER_ARGV_TOKEN on that shape. (3) A file listed in NON_DEV_SERVER_SPAWN_SITES now boots a dev server: move it to DEV_SERVER_SPAWN_SITES and give its spawn both isolation env keys. (4) A pinned file stopped parsing under the ts-morph program this guard runs, which is separate from the repo compiler: a file it cannot parse resolves no spawn call at all, and the isolation rule above reports that syntax error for the same file on the same run, so fix the syntax rather than either list. A site that drops out of this set carries no enforced isolation contract however its spawn env changes',
    ).toEqual([...DEV_SERVER_SPAWN_SITES].sort());
  });

  test('every child-process call site under the e2e directories is pinned', () => {
    expect(
      mirroredFilesWithChildProcessCalls(e2eTsFiles),
      'the set of files spawning a child process no longer matches the pinned sites — one was added, renamed, or moved, and the isolation checks above stopped covering it. Add it to DEV_SERVER_SPAWN_SITES and give its spawn both isolation env keys, or, if it does not boot a dev server, add it to NON_DEV_SERVER_SPAWN_SITES. The two lists must stay disjoint: a file in NON_DEV_SERVER_SPAWN_SITES that boots a dev server reds the selection assertion above. Files carrying the mirror-excluded infix are outside this pin because they do not exist on the public mirror; the corpus-wide isolation rule above still scans them',
    ).toEqual(PINNED_SPAWN_SITES);
  });

  test('the child-process completeness pin sees namespaced calls and not RegExp.prototype.exec', () => {
    expect(CHILD_PROCESS_CALL_PATTERN.test("const proc = cp.spawn('pnpm', argv);")).toBe(true);
    expect(
      CHILD_PROCESS_CALL_PATTERN.test("childProcess.execFileSync('git', ['init', '-q']);"),
    ).toBe(true);
    expect(CHILD_PROCESS_CALL_PATTERN.test('const child = node.fork(workerPath);')).toBe(true);
    expect(CHILD_PROCESS_CALL_PATTERN.test("execFileSync('git', ['init', '-q']);")).toBe(true);
    expect(CHILD_PROCESS_CALL_PATTERN.test("exec('ls');")).toBe(true);

    expect(CHILD_PROCESS_CALL_PATTERN.test('const match = re.exec(line);')).toBe(false);
    expect(CHILD_PROCESS_CALL_PATTERN.test('const match = /a(b)/.exec(line);')).toBe(false);
    expect(CHILD_PROCESS_CALL_PATTERN.test("const label = 'respawn(';")).toBe(false);
    expect(CHILD_PROCESS_CALL_PATTERN.test('await page.waitForSelector(sel);')).toBe(false);
  });

  test('spawn-isolation rule fires on a planted violation and not on adjacent negatives', () => {
    const spawnCallHead = devServerSpawnCallHead(e2eTsFiles, DEV_SERVER_SPAWN_SITES[0]);

    const planted = [spawnCallHead, '  env: { ...process.env, VITE_PORT: String(port) },', '});'];
    const fired = scanPlantedSpawnIsolation(planted);
    expect(
      missingKeysOf(fired),
      `the rule did not report one violation per missing isolation key on ${DEV_SERVER_SPAWN_SITES[0]}'s own spawn call with both keys stripped`,
    ).toEqual([...SPAWN_REQUIRED_ENV_KEYS].sort());
    expect(fired.violations[0]?.line).toBe(1);

    const compliant = [
      spawnCallHead,
      "  env: { OK_TEST_VITE_CACHE_DIR: dir, OK_TEST_SKIP_I18N_COMPILE: '1' },",
      '});',
    ];
    expect(scanPlantedSpawnIsolation(compliant).violations).toEqual([]);

    const otherSpawn = ["const proc = spawn('node', ['script.js'], { env: {} });"];
    const otherSpawnScan = scanPlantedSpawnIsolation(otherSpawn);
    expect(otherSpawnScan.devServerSpawnLines).toEqual([]);
    expect(otherSpawnScan.violations).toEqual([]);

    const notASpawn = ["const cmd = 'pnpm run dev --host 127.0.0.1';"];
    expect(scanPlantedSpawnIsolation(notASpawn).devServerSpawnLines).toEqual([]);

    const halfCompliant = [spawnCallHead, '  env: { OK_TEST_VITE_CACHE_DIR: dir },', '});'];
    expect(missingKeysOf(scanPlantedSpawnIsolation(halfCompliant))).toEqual([
      'OK_TEST_SKIP_I18N_COMPILE',
    ]);

    const compliantSibling = [
      spawnCallHead,
      "  env: { OK_TEST_VITE_CACHE_DIR: d, OK_TEST_SKIP_I18N_COMPILE: '1' },",
      '});',
    ];
    const secondSpawnUnisolated = [
      ...compliantSibling,
      spawnCallHead.replace('const proc', 'const second'),
      '  env: { VITE_PORT: String(port) },',
      '});',
    ];
    const secondFired = scanPlantedSpawnIsolation(secondSpawnUnisolated);
    expect(
      secondFired.violations.map((violation) => violation.line),
      'an un-isolated second dev-server spawn is immunised by a compliant sibling in the same file, so the contract is enforced per file rather than per spawn',
    ).toEqual([4, 4]);
    expect(missingKeysOf(secondFired)).toEqual([...SPAWN_REQUIRED_ENV_KEYS].sort());

    const twoCompliant = [
      ...compliantSibling,
      compliantSibling[0]?.replace('const proc', 'const second') ?? '',
      ...compliantSibling.slice(1),
    ];
    expect(scanPlantedSpawnIsolation(twoCompliant).violations).toEqual([]);
  });

  test("spawn-isolation rule counts only the keys a spawn's own env object declares", () => {
    const spawnCallHead = devServerSpawnCallHead(e2eTsFiles, DEV_SERVER_SPAWN_SITES[0]);
    const bothKeysMissing = [...SPAWN_REQUIRED_ENV_KEYS].sort();

    const keysOnlyInComment = [
      spawnCallHead,
      `  // ${SPAWN_REQUIRED_ENV_KEYS.join(' and ')} belong here`,
      `  // ${SPAWN_REQUIRED_ENV_KEYS[1]}: pending`,
      '  env: { VITE_PORT: String(port) },',
      '});',
    ];
    expect(
      missingKeysOf(scanPlantedSpawnIsolation(keysOnlyInComment)),
      'a comment naming the isolation keys satisfied the contract, so the rule asked whether the source spells the key rather than whether the spawn declares it',
    ).toEqual(bothKeysMissing);

    const keysOnlyInString = [
      spawnCallHead,
      `  env: { BANNER: '${SPAWN_REQUIRED_ENV_KEYS[0]}: unset', VITE_PORT: String(port) },`,
      '});',
    ];
    expect(
      missingKeysOf(scanPlantedSpawnIsolation(keysOnlyInString)),
      'a string literal naming an isolation key satisfied the contract, so the rule asked whether the source spells the key rather than whether the spawn declares it',
    ).toEqual(bothKeysMissing);

    const keysOutsideEnv = [
      spawnCallHead,
      `  ${SPAWN_REQUIRED_ENV_KEYS[0]}: viteCacheDir,`,
      `  ${SPAWN_REQUIRED_ENV_KEYS[1]}: '1',`,
      '  env: { ...process.env },',
      '});',
    ];
    expect(
      missingKeysOf(scanPlantedSpawnIsolation(keysOutsideEnv)),
      'an isolation key spelled as a sibling of `env` rather than inside it satisfied the contract, so the spawn passes the guard while the child process never receives the variable',
    ).toEqual(bothKeysMissing);

    const inheritedEnvOnly = [spawnCallHead, '  env: { ...process.env },', '});'];
    expect(
      missingKeysOf(scanPlantedSpawnIsolation(inheritedEnvOnly)),
      'a bare `...process.env` spread satisfied the contract, but a spread declares no named key and the parent env is exactly the shared state this contract isolates against',
    ).toEqual(bothKeysMissing);

    const noOptionsArgument = ["const proc = spawn('pnpm', ['run', 'dev', '--host', '::1']);"];
    expect(
      missingKeysOf(scanPlantedSpawnIsolation(noOptionsArgument)),
      'a dev-server spawn with no options argument at all declares no env, so both keys are definitively absent rather than unreadable',
    ).toEqual(bothKeysMissing);

    const shorthandEntries = [
      spawnCallHead,
      `  env: { ...process.env, ${SPAWN_REQUIRED_ENV_KEYS[0]}, ${SPAWN_REQUIRED_ENV_KEYS[1]} },`,
      '});',
    ];
    expect(
      scanPlantedSpawnIsolation(shorthandEntries).violations,
      'shorthand env entries declare the keys just as a property assignment does, so reporting them missing would push authors off a legal form',
    ).toEqual([]);

    const quotedKeyNames = [
      spawnCallHead,
      `  env: { '${SPAWN_REQUIRED_ENV_KEYS[0]}': dir, '${SPAWN_REQUIRED_ENV_KEYS[1]}': '1' },`,
      '});',
    ];
    expect(
      scanPlantedSpawnIsolation(quotedKeyNames).violations,
      'string-literal property names declare the keys just as bare identifiers do',
    ).toEqual([]);
  });

  test('spawn-isolation rule reports an env it cannot read as unconfirmed, not as a missing key', () => {
    const spawnCallHead = devServerSpawnCallHead(e2eTsFiles, DEV_SERVER_SPAWN_SITES[0]);

    const cases: Array<{ label: string; lines: string[]; detailIncludes: string }> = [
      {
        label: 'env built by a call expression',
        lines: [spawnCallHead, '  env: buildWorkerEnv(port, viteCacheDir),', '});'],
        detailIncludes: 'buildWorkerEnv(port, viteCacheDir)',
      },
      {
        label: 'env passed by shorthand',
        lines: [spawnCallHead, '  env,', '});'],
        detailIncludes: 'shorthand',
      },
      {
        label: 'options spread with no own env',
        lines: [spawnCallHead, '  ...baseSpawnOptions,', '  cwd: APP_PACKAGE_ROOT,', '});'],
        detailIncludes: 'declares no own `env`',
      },
      {
        label: 'options spread after env',
        lines: [
          spawnCallHead,
          "  env: { OK_TEST_VITE_CACHE_DIR: d, OK_TEST_SKIP_I18N_COMPILE: '1' },",
          '  ...overrides,',
          '});',
        ],
        detailIncludes: 'after `env`',
      },
      {
        label: 'computed env key',
        lines: [
          spawnCallHead,
          "  env: { [CACHE_DIR_VAR]: d, OK_TEST_SKIP_I18N_COMPILE: '1' },",
          '});',
        ],
        detailIncludes: 'computed key',
      },
      {
        label: 'call extent never closes',
        lines: [
          spawnCallHead,
          "  env: { OK_TEST_VITE_CACHE_DIR: d, OK_TEST_SKIP_I18N_COMPILE: '1',",
        ],
        detailIncludes: 'does not parse',
      },
    ];

    for (const { label, lines, detailIncludes } of cases) {
      const scan = scanPlantedSpawnIsolation(lines);
      expect(
        missingKeysOf(scan),
        `${label}: reported as a missing isolation key, so the failure sends a reader looking for a key that is not the problem — the guard could not read this spawn's env at all`,
      ).toEqual([]);
      const details = undeterminableDetails(scan);
      expect(
        details.length,
        `${label}: the guard read an env it has no way to read, so a spawn whose isolation cannot be established passes as compliant`,
      ).toBe(1);
      expect(details[0]).toContain(detailIncludes);
    }

    const unparseable = scanPlantedSpawnIsolation([
      spawnCallHead,
      "  env: { OK_TEST_VITE_CACHE_DIR: d, OK_TEST_SKIP_I18N_COMPILE: '1',",
    ]);
    expect(
      unparseable.devServerSpawnLines,
      'a file the guard cannot parse still resolved a dev-server spawn, so the gate-population anchor below would not drop such a file and the parse cause it names could never arise',
    ).toEqual([]);
  });

  test('spawn-isolation rule reports a key a foreign env spread may carry as unconfirmed', () => {
    const spawnCallHead = devServerSpawnCallHead(e2eTsFiles, DEV_SERVER_SPAWN_SITES[0]);

    const foreignSpread = [
      spawnCallHead,
      `  env: { ...process.env, ...workerServerEnv, ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir },`,
      '});',
    ];
    const scan = scanPlantedSpawnIsolation(foreignSpread);
    expect(
      missingKeysOf(scan),
      "a key absent from an env object's own properties was reported known-absent while the object spreads another one that may carry it, so the failure sends a reader after a key the guard never looked for",
    ).toEqual([]);
    expect(
      unconfirmedKeysOf(scan),
      'the key a foreign spread may carry was not reported at all, so a spawn whose isolation cannot be established passes as compliant',
    ).toEqual([SPAWN_REQUIRED_ENV_KEYS[1]]);
    expect(
      scan.violations.map(describeSpawnViolation).join('\n'),
      'the unconfirmed verdict does not name the spread that hid the key, so a reader cannot tell why the guard could not see it',
    ).toContain('workerServerEnv');

    const declaredBesideForeignSpread = [
      spawnCallHead,
      `  env: { ...process.env, ...workerServerEnv, ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: '1' },`,
      '});',
    ];
    expect(
      scanPlantedSpawnIsolation(declaredBesideForeignSpread).violations,
      'a foreign spread made a spawn that declares both isolation keys outright report as un-isolated, which is the shape the real worker fixture spawns with',
    ).toEqual([]);

    const trailingForeignSpread = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: '1', ...workerServerEnv },`,
      '});',
    ];
    const trailingScan = scanPlantedSpawnIsolation(trailingForeignSpread);
    expect(
      missingKeysOf(trailingScan),
      'a key the env object declares outright was reported known-absent, so the failure sends a reader after a key that is spelled at the call',
    ).toEqual([]);
    expect(
      unconfirmedKeysOf(trailingScan),
      'a foreign spread placed after both declared keys cleared the spawn, but a later spread overrides same-name properties and may hand the child an undefined the runtime then drops from its env, so the isolation this guard exists to establish is not established',
    ).toEqual([...SPAWN_REQUIRED_ENV_KEYS].sort());
    expect(
      trailingScan.violations.map(describeSpawnViolation).join('\n'),
      'the unconfirmed verdict does not name the trailing spread or say that it may replace the declared key, so a reader is told the key is absent when the real problem is that the declaration is positioned before the spread',
    ).toContain('workerServerEnv');
    expect(
      trailingScan.violations.map(describeSpawnViolation).join('\n'),
      'the unconfirmed verdict does not put the trailing spread on the replace axis, so the remedy a reader reaches for is to declare a key that is already declared',
    ).toContain('may replace it');

    const trailingParentEnvSpread = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: '1', ...${PARENT_ENV_SPREAD} },`,
      '});',
    ];
    const trailingParentScan = scanPlantedSpawnIsolation(trailingParentEnvSpread);
    expect(
      missingKeysOf(trailingParentScan),
      'a key the env object declares outright was reported known-absent when the trailing spread is the parent env',
    ).toEqual([]);
    expect(
      unconfirmedKeysOf(trailingParentScan),
      'a trailing `...process.env` cleared the spawn: the carve-out that lets a parent-env spread stand where no key is declared is about whether the parent can SUPPLY a key, and it does not extend to a parent env spread that REPLACES a declared key with exactly the shared value this contract isolates against',
    ).toEqual([...SPAWN_REQUIRED_ENV_KEYS].sort());

    const spreadBetweenDeclaredKeys = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ...overrides, ${SPAWN_REQUIRED_ENV_KEYS[1]}: '1' },`,
      '});',
    ];
    const betweenScan = scanPlantedSpawnIsolation(spreadBetweenDeclaredKeys);
    expect(
      missingKeysOf(betweenScan),
      'a key declared on either side of a spread was reported known-absent',
    ).toEqual([]);
    expect(
      unconfirmedKeysOf(betweenScan),
      'the verdict is not positional: only the key declared BEFORE the spread can be replaced by it, so reporting the key declared after it too makes any spread poison the whole env object and the guard stops discriminating between the two positions',
    ).toEqual([SPAWN_REQUIRED_ENV_KEYS[0]]);

    const redeclaredAfterSpread = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ...overrides, ${SPAWN_REQUIRED_ENV_KEYS[0]}: fallbackDir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: '1' },`,
      '});',
    ];
    expect(
      scanPlantedSpawnIsolation(redeclaredAfterSpread).violations,
      're-declaring a key after the last spread is the escape hatch out of the shadowed verdict — the spread cannot replace what follows it — and closing it leaves an author who took the remedy the failure message prescribes with no way to green the guard',
    ).toEqual([]);
  });

  test('spawn-isolation rule reports a key whose declared value is `undefined` as cleared', () => {
    const spawnCallHead = devServerSpawnCallHead(e2eTsFiles, DEV_SERVER_SPAWN_SITES[0]);

    const oneKeyCleared = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: undefined },`,
      '});',
    ];
    const clearedScan = scanPlantedSpawnIsolation(oneKeyCleared);
    expect(
      clearedKeysOf(clearedScan),
      'a key spelled in the env object with the value `undefined` counted as declared, but Node drops undefined values out of `env` before the child starts, so the child runs against the shared vite cache and the shared i18n compile exactly as if the key had never been written',
    ).toEqual([SPAWN_REQUIRED_ENV_KEYS[1]]);
    expect(
      clearedScan.violations.length,
      'a key cleared to `undefined` produced a verdict per required key rather than one for the key that is cleared, so the failure names a compliant key too',
    ).toBe(1);
    expect(
      missingKeysOf(clearedScan),
      'a key the env object spells outright was reported known-absent, so the failure sends a reader looking for a key that is written at the call and points away from the value that drops it',
    ).toEqual([]);
    expect(
      clearedScan.violations.map(describeSpawnViolation).join('\n'),
      'the cleared verdict does not say that the value is `undefined` and that Node drops it, so a reader who can see the key at the call has no way to tell what the guard objects to',
    ).toContain('undefined');

    const bothKeysCleared = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: undefined, ${SPAWN_REQUIRED_ENV_KEYS[1]}: undefined },`,
      '});',
    ];
    expect(
      clearedKeysOf(scanPlantedSpawnIsolation(bothKeysCleared)),
      'an env object that clears both isolation keys reported fewer than one verdict per cleared key, so an author who fixes the one that is named is told the spawn is compliant while the other key still never reaches the child',
    ).toEqual([...SPAWN_REQUIRED_ENV_KEYS].sort());

    const voidOperatorValue = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: void 0 },`,
      '});',
    ];
    expect(
      clearedKeysOf(scanPlantedSpawnIsolation(voidOperatorValue)),
      'a key written `void 0` counted as declared, but `void` evaluates to `undefined` whatever operand follows it, so Node drops the key out of `env` exactly as it drops a bare `undefined` and the child runs against the shared vite cache and the shared i18n compile',
    ).toEqual([SPAWN_REQUIRED_ENV_KEYS[1]]);

    const voidCallValue = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: void resolveFlag() },`,
      '});',
    ];
    expect(
      clearedKeysOf(scanPlantedSpawnIsolation(voidCallValue)),
      'a `void` whose operand is a call counted as declared, but the operand is discarded and only its side effects run, so the key reaches the child no more than `void 0` does and no reading of the operand could produce another verdict',
    ).toEqual([SPAWN_REQUIRED_ENV_KEYS[1]]);

    const clearedThenRedeclared = [
      spawnCallHead,
      `  env: { ${SPAWN_REQUIRED_ENV_KEYS[1]}: undefined, ${SPAWN_REQUIRED_ENV_KEYS[0]}: dir, ${SPAWN_REQUIRED_ENV_KEYS[1]}: '1' },`,
      '});',
    ];
    expect(
      scanPlantedSpawnIsolation(clearedThenRedeclared).violations,
      'a key cleared to `undefined` and then re-declared with a real value reported as cleared, but object literals are last-wins, so the child does receive the key and the guard reds a spawn that is isolated',
    ).toEqual([]);
  });

  test('spawn-isolation rule clears compliant spawns whose env values carry operators or span lines', () => {
    const spawnCallHead = devServerSpawnCallHead(e2eTsFiles, DEV_SERVER_SPAWN_SITES[0]);

    const divisionInEnvValue = [
      spawnCallHead,
      '  env: {',
      '    ...process.env,',
      '    OK_TEST_VITE_CACHE_DIR: viteCacheDir,',
      "    OK_TEST_SKIP_I18N_COMPILE: '1',",
      '    OK_TEST_BOOT_BUDGET_MS: String(budgetMs(workerCount) / 2),',
      '  },',
      '});',
    ];
    expect(
      scanPlantedSpawnIsolation(divisionInEnvValue).violations,
      'a division operator in an env value made a fully compliant spawn report as un-isolated, so ordinary arithmetic in a spawn env reds this guard',
    ).toEqual([]);

    const multiLineTemplateEnvValue = [
      spawnCallHead,
      '  env: {',
      '    ...process.env,',
      '    OK_TEST_VITE_CACHE_DIR: viteCacheDir,',
      "    OK_TEST_SKIP_I18N_COMPILE: '1',",
      '    OK_TEST_BANNER: `worker boot',
      `      port \${port}`,
      `      cache \${viteCacheDir}\`,`,
      '  },',
      '});',
    ];
    expect(
      scanPlantedSpawnIsolation(multiLineTemplateEnvValue).violations,
      'an env value spelled as a multi-line template literal made a fully compliant spawn report as un-isolated',
    ).toEqual([]);
  });

  test('dev-harness import rule fires on a static import and not on the sanctioned shapes', () => {
    expect(
      isStaticDevHarnessImport("import { installAcpThreadHarness } from './dev-thread-harness';"),
    ).toBe(true);
    expect(
      isStaticDevHarnessImport(
        "import { installAcpThreadHarness } from '@/lib/acp/dev-thread-harness';",
      ),
    ).toBe(true);
    expect(isStaticDevHarnessImport("export * from './dev-thread-harness';")).toBe(true);

    expect(
      isStaticDevHarnessImport("import type { AcpThreadHarness } from './dev-thread-harness';"),
    ).toBe(false);
    expect(
      isStaticDevHarnessImport("  void import('@/lib/acp/dev-thread-harness').then(fn);"),
    ).toBe(false);
    expect(isStaticDevHarnessImport("import { x } from './thread-client';")).toBe(false);
  });

  test('window.__activeEditor is published only by DocumentContext.tsx (regression — PR #168 merge collision)', () => {
    const srcFiles = listAppSrcTsFiles();
    const directAssignPattern = /window\.__activeEditor\s*=/;
    const equalityPattern = /window\.__activeEditor\s*===?/;
    const definePropertyPattern =
      /Object\.defineProperty\s*\(\s*window\s*,\s*['"]__activeEditor['"]/;
    const ownerFile = 'packages/app/src/editor/DocumentContext.tsx';

    const violations: string[] = [];
    for (const file of srcFiles) {
      if (file.path === ownerFile) continue;
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        const isAssign = directAssignPattern.test(line) && !equalityPattern.test(line);
        const isDefine = definePropertyPattern.test(line);
        if (!isAssign && !isDefine) continue;
        violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `window.__activeEditor must be published only by DocumentContext.tsx — additional writers collide with the getter-only accessor and throw TypeError on doc open in DEV. Delete the direct write and read through window.__activeEditor (the getter already resolves via the active-editor.ts registry, which TiptapEditor already populates via registerEditor/unregisterEditor):\n${violations.join('\n')}`,
      );
    }
  });

  test('selection-halo CSS rules use plugin-state propagation, not `:has()` (Precedent #34)', () => {
    const cssPath = join(APP_SRC_DIR, 'globals.css');
    const css = readFileSync(cssPath, 'utf-8');
    const lines = css.split('\n');

    const hasPattern = /:has\(/;
    const selectionMarker =
      /data-selected|data-has-child-selected|--selection-halo|selection-halo-opacity/;
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!hasPattern.test(line)) continue;

      const windowStart = Math.max(0, i - 3);
      const windowEnd = Math.min(lines.length, i + 4);
      const selectorContext = lines.slice(windowStart, windowEnd).join('\n');

      if (selectionMarker.test(selectorContext)) {
        violations.push(`  packages/app/src/globals.css:${i + 1}    ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Selection-halo CSS rules must not use \`:has()\` — precedent #34 requires innermost-wins via plugin-state propagation (\`data-has-child-selected\`). Move the cascade logic into SelectionStatePlugin's apply function and let JsxComponentView emit the attribute:\n${violations.join('\n')}`,
      );
    }
  });

  test('selection-halo transition uses `var(--ease-out-strong)`, not bare `ease-out` (round-2 review fix)', () => {
    const cssPath = join(APP_SRC_DIR, 'globals.css');
    const css = readFileSync(cssPath, 'utf-8');
    const lines = css.split('\n');

    const haloStart = lines.findIndex((l) => /\/\*\s*7a\..*selection/i.test(l));
    if (haloStart === -1) {
      throw new Error(
        `globals.css: expected "7a. Selection halo" section anchor not found — same rename/removal case as the :has() rule above.`,
      );
    }
    const sectionHeaderPattern = /\/\*\s*(?:7b|8|9)\./i;
    let haloEnd = lines.length;
    for (let i = haloStart + 1; i < lines.length; i++) {
      if (sectionHeaderPattern.test(lines[i] ?? '')) {
        haloEnd = i;
        break;
      }
    }

    const violations: string[] = [];
    for (let i = haloStart; i < haloEnd; i++) {
      const line = lines[i] ?? '';
      if (!line.includes('transition')) continue;
      const stripped = line.replace(/var\([^)]*\)/g, '');
      if (/\bease-out\b/.test(stripped)) {
        violations.push(`  packages/app/src/globals.css:${i + 1}    ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Selection-halo transition uses bare \`ease-out\` — use \`var(--ease-out-strong)\` for consistency with the repo's 7 other transitions (round-2 review fix, commit 4e9d96a5):\n${violations.join('\n')}`,
      );
    }
  });

  test('no remote placeholder-image hosts in tests/{stress,visual,a11y} (PRD-8532)', () => {
    const violations = collectMatches(e2eTsFiles, isRemoteImageHost);
    if (violations.length > 0) {
      throw new Error(
        `Remote placeholder-image host found — write a local fixture under tests/stress/_fixtures and wait with waitForImageDecoded (from the ./_helpers barrel) instead:\n${violations.join('\n')}`,
      );
    }
  });

  test('remote-image-host rule fires on planted hosts and not on adjacent negatives', () => {
    expect(isRemoteImageHost('<img src="https://picsum.photos/200" alt="remote" />')).toBe(true);
    expect(isRemoteImageHost('![alt](https://via.placeholder.com/50)')).toBe(true);
    expect(isRemoteImageHost('src="https://IMAGES.UNSPLASH.COM/photo-1" />')).toBe(true);
    expect(isRemoteImageHost("const REMOTE_IMAGE_HOSTS = ['picsum.photos'];")).toBe(true);
    expect(isRemoteImageHost("await page.route('**://picsum.photos/**', handler);")).toBe(true);
    expect(isRemoteImageHost("await srcInput.fill('https://picsum.photos/200');")).toBe(true);

    expect(isRemoteImageHost('<img src="https://example.com/safe.png" alt="safe" />')).toBe(false);
    expect(isRemoteImageHost('![remote](https://invalid.invalid/missing.png)')).toBe(false);
    expect(isRemoteImageHost('<img src="/real-shot.png" alt="local" />')).toBe(false);
    expect(isRemoteImageHost("const url = 'https://unsplash.com/photos/abc';")).toBe(false);
    expect(isRemoteImageHost("const s = 'notpicsum.photosly';")).toBe(false);
    expect(isRemoteImageHost("const s = 'picsumXphotos';")).toBe(false);
  });

  test('predev routes i18n compile through the OK_TEST_SKIP_I18N_COMPILE guard (not a direct compile)', () => {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const predev = pkg.scripts?.predev ?? '';
    const errors: string[] = [];
    if (!predev.includes('i18n-compile-unless-skipped.sh')) {
      errors.push(
        'packages/app/package.json "predev" must route the i18n compile through ' +
          'scripts/i18n-compile-unless-skipped.sh (the OK_TEST_SKIP_I18N_COMPILE guard).',
      );
    }
    if (/i18n:compile|\blingui compile\b/.test(predev)) {
      errors.push(
        'packages/app/package.json "predev" invokes the i18n compile directly, bypassing the ' +
          'OK_TEST_SKIP_I18N_COMPILE guard — every concurrent e2e dev-server boot then rewrites ' +
          'src/locales/<locale>/messages.json and Vite full-page-reloads running tests mid-evaluate.',
      );
    }
    if (errors.length > 0) {
      throw new Error(`${errors.join('\n')}\nFound predev:\n  ${predev}`);
    }
  });
});
