import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsoncOrError } from '../../../scripts/read-jsonc.mjs';

const PACKAGE_ROOT = process.env.OK_PUBLISHED_DTS_ROOT
  ? resolve(process.env.OK_PUBLISHED_DTS_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_ROOT_SOURCE = process.env.OK_PUBLISHED_DTS_ROOT ? 'OK_PUBLISHED_DTS_ROOT' : null;
const PUBLISHED_DECLARATION_NAME = 'dist/index.d.mts';
const PUBLISHED_DECLARATION = join(PACKAGE_ROOT, PUBLISHED_DECLARATION_NAME);
const CHECK_PROJECT = 'tsconfig.check.json';
const TSC_BIN = join(
  PACKAGE_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);

export const PINNED_THIRD_PARTY_INLINING_ARTIFACTS = [
  {
    origin: '@tiptap/core',
    mechanism:
      "tiptap's `declare module '@tiptap/core'` augmentations write `ParentConfig<NodeConfig<Options>>`, relying on NodeConfig's second type parameter defaulting. The inlined copy of NodeConfig loses that default, so the one-argument references no longer satisfy it. tiptap raises the diagnostic at two augmentation sites, which is what count 2 records.",
    file: PUBLISHED_DECLARATION_NAME,
    code: 'TS2314',
    message: "Generic type 'NodeConfig<Options, Storage>' requires 2 type argument(s).",
    count: 2,
  },
];

export const PUBLISHED_SURFACE_BASELINE = {
  capturedFrom:
    "TypeScript 5.9.3, counted trivia-free: comments and string literals excluded. Recorded in the internal evidence tree's dts-baseline-5.9.3/index.tokens.txt, which this package does not ship. Raising a ceiling is a reviewed edit against that token stream, not a regeneration from the artifact that just failed. If you are an outside contributor and a ceiling blocks you, say so on the pull request and ask a maintainer to check it against that token stream: these numbers are a pre-change capture you cannot see, not a budget to raise.",
  anyCeiling: 202,
  unknownCeiling: 128,
  exportedSymbols: [
    'ALL_EDITOR_IDS',
    'BundleExtraFile',
    'BundleLogger',
    'CliProbeContext',
    'CollectReportBundleOptions',
    'EDITOR_LABELS',
    'EDITOR_TARGETS',
    'EditorId',
    'EditorMcpResult',
    'EditorMcpTarget',
    'EnsurePiBridgeResult',
    'ExcludeWriteResult',
    'ExpectedShareRepo',
    'GhAccount',
    'GhDetectResult',
    'HOSTS_WITH_USER_SKILL_DIR',
    'IntegrationWriteOutcome',
    'LAUNCH_CONFIG_NAME',
    'LanguageMetadata',
    'LoadConfigResult',
    'McpConfigDeclineEvent',
    'McpConfigDeclineScope',
    'McpConfigMigrateEvent',
    'McpConfigMigrateScope',
    'McpDeclineReason',
    'McpEntryClassification',
    'McpInstallOptions',
    'McpRemoveOutcome',
    'OwnManagedMcpEntryHit',
    'PATH_SHIM_BEGIN',
    'PATH_SHIM_BLOCK_RE',
    'PATH_SHIM_END',
    'ParsedGitHubBlobUrl',
    'ParsedGitHubShareTarget',
    'ParsedGitHubTreeUrl',
    'PathDiscovery',
    'PathInstallConsent',
    'PathInstallMarker',
    'PiBridgeFileState',
    'PiBridgeState',
    'PiBridgeWriteAction',
    'PiTrustState',
    'PiTrustWriteAction',
    'PreviewResult',
    'ProjectAiIntegrationsResult',
    'ProjectSkillRemoveResult',
    'ProjectSkillResult',
    'ReportBundleLevel',
    'ReportBundleResult',
    'ReportBundleSummary',
    'ResolveProjectRootOptions',
    'ResolveProjectRootResult',
    'ShareFolderValidationResult',
    'SharingMode',
    'SkillBundleTarget',
    'TokenStore',
    'TrackedRefusal',
    'UserMcpConfigsOptions',
    'UserSkillWriteResult',
    'addOkPathsToGitExclude',
    'assertProjectPathSafe',
    'buildManagedServerEntry',
    'buildMcpConfigDeclineEvent',
    'buildMcpConfigMigrateEvent',
    'classifyExistingMcpEntry',
    'collectReportBundle',
    'createCliProbeResolver',
    'createTokenStore',
    'defaultBugReportZipPath',
    'detectGh',
    'detectGhAccounts',
    'detectInstalledEditors',
    'droppedManagedKeys',
    'editorConfigPathDisplay',
    'editorEntryLocator',
    'ensurePiBridge',
    'formatTrackedRemediation',
    'getExcludedOkPaths',
    'getInstalledSkillProjectionPaths',
    'getNativeTomlMcpEditor',
    'getOkArtifactPaths',
    'isEntryUpToDate',
    'isOwnManagedEntry',
    'loadConfig',
    'makeLazyProbeTokenStore',
    'okBugReportsDir',
    'parseGitHubBlobUrl',
    'parseGitHubShareUrl',
    'parseGitHubTreeUrl',
    'parseGitUrl',
    'pathInstallMarkerPath',
    'previewContent',
    'probeOwnManagedEditorMcpEntry',
    'probePiBridgeState',
    'probeTrackedOkPaths',
    'readExistingMcpEntry',
    'readSharingMode',
    'redactContent',
    'removeOkPathsFromGitExclude',
    'removeOwnMcpEntry',
    'removeProjectSkill',
    'removeUserGlobalSkillBundle',
    'removeUserSkill',
    'resolveProjectRoot',
    'runStop',
    'truncatePriorEntry',
    'userGlobalSkillBundleTargets',
    'userSkillPresentAnywhere',
    'validateLocalFolderForShare',
    'writeEditorMcpConfig',
    'writeProjectAiIntegrations',
    'writeProjectSkill',
    'writeUserMcpConfigs',
    'writeUserSkill',
  ],
};

const DIAGNOSTIC_LINE =
  /^(?<file>\S.*?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+): (?<message>.*)$/;

export function partitionOutput(tscOutput) {
  const diagnostics = [];
  const residual = [];
  for (const line of tscOutput.split('\n')) {
    if (line.trim() === '') continue;
    const match = DIAGNOSTIC_LINE.exec(line);
    if (match?.groups) {
      diagnostics.push({
        file: match.groups.file,
        line: Number(match.groups.line),
        code: match.groups.code,
        message: match.groups.message,
      });
      continue;
    }
    if (/^\s/.test(line)) continue;
    residual.push(line);
  }
  return { diagnostics, residual };
}

export function classifyRun({ status, signal, diagnostics, residual }) {
  if (signal) {
    return `tsc was killed by ${signal} before it could report on the published declaration.`;
  }
  if (residual.length > 0) {
    return `tsc printed ${residual.length} line(s) this check cannot read as diagnostics, so the pin reconciliation below would have run against a partial picture:\n\n  ${residual.join('\n  ')}`;
  }
  if ((status !== 0) !== diagnostics.length > 0) {
    return `tsc exited ${status} while ${diagnostics.length} diagnostic(s) parsed out of its output. The exit code and the parsed diagnostics disagree, so one of them is not being read correctly.`;
  }
  return null;
}

const signature = (diagnostic) => `${diagnostic.file}: ${diagnostic.code}: ${diagnostic.message}`;

export const pinnedOccurrences = (pinned) =>
  pinned.reduce((total, entry) => total + (entry.count ?? 1), 0);

function toCounts(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

export function reconcile(diagnostics, pinned) {
  const observed = toCounts(diagnostics.map(signature));
  const expected = toCounts(
    pinned.flatMap((entry) => Array.from({ length: entry.count ?? 1 }, () => signature(entry))),
  );
  const provenance = new Map(pinned.map((entry) => [signature(entry), entry]));
  const unexpected = [];
  const missing = [];

  for (const [key, count] of observed) {
    const surplus = count - (expected.get(key) ?? 0);
    if (surplus > 0) unexpected.push({ signature: key, count: surplus });
  }
  for (const [key, count] of expected) {
    const deficit = count - (observed.get(key) ?? 0);
    if (deficit > 0) {
      const pin = provenance.get(key);
      missing.push({
        signature: key,
        count: deficit,
        origin: pin.origin,
        mechanism: pin.mechanism,
      });
    }
  }
  return { unexpected, missing };
}

const NAMED_EXPORT_BLOCK = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const STAR_EXPORT = /^export\s+(?:type\s+)?\*/m;
const INKEEP_SPECIFIER = /@inkeep\//;

export function readPublishedSurface(text) {
  const declarations = stripTrivia(text);
  const code = stripTrivia(text, { stripStrings: true });
  const exported = new Set();
  let namedExportBlocks = 0;
  for (const block of declarations.matchAll(NAMED_EXPORT_BLOCK)) {
    namedExportBlocks += 1;
    for (const entry of block[1].split(',')) {
      const specifier = entry.trim();
      if (specifier === '') continue;
      const aliased = /\sas\s+(\S+)$/.exec(specifier);
      exported.add(aliased ? aliased[1] : specifier.replace(/^type\s+/, ''));
    }
  }
  return {
    exported,
    namedExportBlocks,
    hasStarExport: STAR_EXPORT.test(declarations),
    anyCount: (code.match(/\bany\b/g) ?? []).length,
    unknownCount: (code.match(/\bunknown\b/g) ?? []).length,
    inkeepLines: declarations.split('\n').filter((line) => INKEEP_SPECIFIER.test(line)),
  };
}

export function stripTrivia(text, { stripStrings = false } = {}) {
  let i = 0;
  const n = text.length;
  let out = '';
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      if (!stripStrings && text.startsWith('///', start)) out += text.slice(start, i);
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i++;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          i++;
          break;
        }
        i++;
      }
      const literal = text.slice(start, i);
      out += stripStrings ? literal.replace(/[^\n]/g, ' ') : literal;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function checkSurface(surface, baseline) {
  const violations = [];
  if (surface.hasStarExport) {
    violations.push(
      'the file carries a top-level `export *`, so its exported symbol set is no longer enumerable from the export statement and this check cannot fence it. Bundle the re-export instead.',
    );
  }
  if (surface.namedExportBlocks === 0 || surface.exported.size === 0) {
    violations.push(
      'no top-level named export block was found, so the exported-symbol comparison below read nothing. A check that compares an empty set to a baseline passes vacuously, so this refuses instead.',
    );
    return violations;
  }
  const dropped = baseline.exportedSymbols.filter((name) => !surface.exported.has(name));
  if (dropped.length > 0) {
    violations.push(
      `${dropped.length} of the ${baseline.exportedSymbols.length} baseline exported symbols are gone from the published surface: ${dropped.join(', ')}. Removing a published export is a consumer-visible break; restore it or land the removal as its own versioned change and re-capture the baseline.`,
    );
  }
  if (surface.inkeepLines.length > 0) {
    violations.push(
      `${surface.inkeepLines.length} line(s) reference \`@inkeep/\`, so the published declaration is not self-contained. Sibling packages are devDependencies and are \`private: true\`, so an npm consumer cannot resolve them:\n\n  ${surface.inkeepLines.slice(0, 5).join('\n  ')}`,
    );
  }
  if (surface.anyCount > baseline.anyCeiling) {
    violations.push(
      `\`any\` occurs ${surface.anyCount} times outside comments and string literals, above the ${baseline.anyCeiling} the 5.9.3 token stream recorded. Either a sibling type degraded to \`any\` — find what stopped resolving — or a new export widened the surface legitimately, in which case land it as its own versioned change and re-capture the ceiling from the trivia-free token count, not the raw whole-file one.`,
    );
  }
  if (surface.unknownCount > baseline.unknownCeiling) {
    violations.push(
      `\`unknown\` occurs ${surface.unknownCount} times outside comments and string literals, above the ${baseline.unknownCeiling} the 5.9.3 token stream recorded. Same two causes and the same remedy as the \`any\` ceiling above.`,
    );
  }
  return violations;
}

export function checkProjectFences(read) {
  const problems = [];
  if (!read.ok) {
    problems.push(
      read.code === 'ENOENT'
        ? `${CHECK_PROJECT} does not exist, so nothing establishes what the type-check below actually opened.`
        : `${CHECK_PROJECT} could not be read: ${read.reason}. Nothing then establishes what the type-check below actually opened.`,
    );
    return problems;
  }
  const project = read.value;
  if (project?.compilerOptions?.skipLibCheck !== false) {
    problems.push(
      `${CHECK_PROJECT} does not set \`skipLibCheck: false\`. The base tsconfig sets it true, and with it on tsc skips every declaration file — including the only file this project lists — so the run would pass without reading the published surface at all.`,
    );
  }
  if (!(project?.files ?? []).includes(PUBLISHED_DECLARATION_NAME)) {
    problems.push(
      `${CHECK_PROJECT} does not list ${PUBLISHED_DECLARATION_NAME} in \`files\`, so the run below type-checks something other than the declaration this guard exists to fence.`,
    );
  }
  const conditions = project?.compilerOptions?.customConditions;
  if (!Array.isArray(conditions) || conditions.length !== 0) {
    problems.push(
      `${CHECK_PROJECT} does not reset \`customConditions\` to [], so a sibling specifier inside the published declaration would resolve through the base tsconfig's source condition rather than the way an npm consumer's compiler resolves it. The "standalone" claim in the success line rests on that reset.`,
    );
  }
  return problems;
}

export function isClean({ unexpected, missing, surfaceViolations, unreadable = null }) {
  return (
    !unreadable && unexpected.length === 0 && missing.length === 0 && surfaceViolations.length === 0
  );
}

export function evaluate({ declarationText, run, pins, baseline, root, rootSource = null }) {
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const { diagnostics, residual } = partitionOutput(output);
  const unreadable = classifyRun({
    status: run.status,
    signal: run.signal,
    diagnostics,
    residual,
  });
  if (unreadable) {
    return {
      code: 1,
      unreadable,
      unexpected: [],
      missing: [],
      surfaceViolations: [],
      out: [],
      err: [
        `check:dts: this check verified nothing, so it is failing rather than reporting a pass.\n\n${unreadable}\n\nFull tsc output:\n${output}`,
      ],
    };
  }

  const { unexpected, missing } = reconcile(diagnostics, pins);
  const surface = readPublishedSurface(declarationText);
  const surfaceViolations = checkSurface(surface, baseline);

  if (pins.length === 0 && diagnostics.length === 0) {
    return {
      code: 1,
      unreadable: `tsc emitted no diagnostics and no artifact is pinned, so nothing in this run proves it opened ${PUBLISHED_DECLARATION_NAME}. A silent pass here is indistinguishable from a project that fences the wrong file or skips declaration checking entirely.`,
      unexpected: [],
      missing: [],
      surfaceViolations,
      out: [],
      err: [
        `check:dts: this check verified nothing, so it is failing rather than reporting a pass.\n\ntsc emitted no diagnostics and PINNED_THIRD_PARTY_INLINING_ARTIFACTS is empty, so the run has no evidence it read ${PUBLISHED_DECLARATION_NAME}. If the pins were emptied because an upstream fix resolved them, replace them with a positive liveness assertion before deleting the last one.`,
        ...surfaceViolations.map((violation) => `  ${violation}\n`),
      ],
    };
  }

  if (isClean({ unexpected, missing, surfaceViolations })) {
    return {
      code: 0,
      unreadable: null,
      unexpected,
      missing,
      surfaceViolations,
      err: [],
      out: [
        `check:dts: OK at ${root}${rootSource === null ? '' : ` [from ${rootSource}]`} — ${PUBLISHED_DECLARATION_NAME} type-checks standalone with skipLibCheck disabled (${pinnedOccurrences(pins)} pinned third-party inlining artifacts across ${pins.length} pin(s), 0 unexpected) and keeps the published surface (${baseline.exportedSymbols.length}/${baseline.exportedSymbols.length} baseline symbols present of ${surface.exported.size} exported, 0 \`@inkeep/\` references, any ${surface.anyCount}/${baseline.anyCeiling}, unknown ${surface.unknownCount}/${baseline.unknownCeiling}).`,
      ],
    };
  }

  const census = `exported ${surface.exported.size}/${baseline.exportedSymbols.length} baseline symbols, any ${surface.anyCount}/${baseline.anyCeiling}, unknown ${surface.unknownCount}/${baseline.unknownCeiling}`;
  const unenumerable =
    surface.hasStarExport || surface.namedExportBlocks === 0 || surface.exported.size === 0;
  const err = [
    unenumerable
      ? `check:dts: the published declaration surface could not be enumerated, so it was never compared against the baseline (${census}). Refusing to report a pass. Baseline: ${baseline.capturedFrom}\n`
      : surfaceViolations.length > 0
        ? `check:dts: the published declaration surface changed (${census}). Baseline: ${baseline.capturedFrom}\n`
        : `check:dts: the published declaration did not type-check as expected (surface unchanged: ${census}).\n`,
  ];
  for (const violation of surfaceViolations) err.push(`  ${violation}\n`);

  if (unexpected.length > 0) {
    err.push(
      'UNEXPECTED diagnostics in the published declaration. This is the fence: a symbol that no longer resolves, a sibling type left dangling, or an internally inconsistent inlined declaration. Fix the exporting package rather than widening the pin.\n',
    );
    for (const entry of unexpected) err.push(`  x${entry.count}  ${entry.signature}`);
    err.push('');
    for (const diagnostic of diagnostics) {
      if (unexpected.some((entry) => entry.signature === signature(diagnostic))) {
        err.push(`  ${diagnostic.file}:${diagnostic.line}  ${diagnostic.code}`);
      }
    }
    err.push('');
  }

  if (missing.length > 0) {
    err.push(
      `PINNED diagnostics that no longer appear (${diagnostics.length} diagnostic(s) were observed in total, so tsc did run). An upstream fix or a bundler change resolved them; delete the matching entries from PINNED_THIRD_PARTY_INLINING_ARTIFACTS so the pin keeps meaning what it says. If that would empty the list, add a positive liveness assertion in the same change: with no pins and no diagnostics this check refuses rather than passing, because nothing would then prove it read the declaration.\n`,
    );
    for (const entry of missing) {
      err.push(`  x${entry.count}  ${entry.signature}`);
      err.push(`          pinned against ${entry.origin}: ${entry.mechanism}`);
    }
    err.push('');
  }

  err.push(`Full tsc output:\n${output}`);
  return { code: 1, unreadable: null, unexpected, missing, surfaceViolations, out: [], err };
}

function main() {
  if (!existsSync(PUBLISHED_DECLARATION)) {
    console.error(
      `check:dts: ${PUBLISHED_DECLARATION} does not exist. Run \`pnpm run build:cli\` first (turbo orders this via dependsOn build).`,
    );
    process.exit(1);
  }

  if (!existsSync(TSC_BIN)) {
    console.error(
      `check:dts: no tsc at ${TSC_BIN}. Run \`pnpm install\` from public/open-knowledge. This check resolves the compiler by absolute path on purpose: falling through to a machine-global tsc would reconcile its diagnostics as if they came from the version this package declares.`,
    );
    process.exit(1);
  }

  const fenceProblems = checkProjectFences(readJsoncOrError(join(PACKAGE_ROOT, CHECK_PROJECT)));
  if (fenceProblems.length > 0) {
    console.error(
      'check:dts: the project this check runs under no longer fences what the success line claims it does.\n',
    );
    for (const problem of fenceProblems) console.error(`  ${problem}`);
    process.exit(1);
  }

  const tsc = spawnSync(TSC_BIN, ['-p', CHECK_PROJECT, '--pretty', 'false'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (tsc.error) {
    console.error(`check:dts: could not run tsc: ${tsc.error.message}`);
    process.exit(1);
  }

  const { code, out, err } = evaluate({
    declarationText: readFileSync(PUBLISHED_DECLARATION, 'utf8'),
    run: tsc,
    pins: PINNED_THIRD_PARTY_INLINING_ARTIFACTS,
    baseline: PUBLISHED_SURFACE_BASELINE,
    root: PACKAGE_ROOT,
    rootSource: PACKAGE_ROOT_SOURCE,
  });
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  process.exit(code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
