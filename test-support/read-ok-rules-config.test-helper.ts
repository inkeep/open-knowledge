import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, inject } from 'vitest';
// @ts-expect-error untyped ESM lint-plugin module
import { RULE_SCOPES } from '../lint-plugins/ok-rules/scope.mjs';
import type { OkRulesFixtureLint } from './ok-rules-fixture-lint.ts';
import { UNCACHED_TIER_CONFIG } from './uncached-tier';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface OkRulesFixtureDiagnostic {
  code: string;
  position: string;
  message: string;
}

function positionOf(line: number, column: number): string {
  return `${line}:${column}`;
}

function comparePositions(a: OkRulesFixtureDiagnostic, b: OkRulesFixtureDiagnostic): number {
  const [aLine, aColumn] = a.position.split(':').map(Number);
  const [bLine, bColumn] = b.position.split(':').map(Number);
  return (
    a.code.localeCompare(b.code) ||
    aLine - bLine ||
    aColumn - bColumn ||
    a.message.localeCompare(b.message)
  );
}

function outsideTheTier(): Error {
  const testPath = expect.getState().testPath;
  const test = testPath
    ? relative(OK_ROOT, testPath).split(sep).join('/')
    : 'lint-plugins/ok-rules/tests';
  return new Error(
    `read-ok-rules-config: no ok-rules fixture lint was provided to this test, so it is running outside the uncached tier, whose global setup lints every fixture once. Run it from the Open Knowledge root with: pnpm exec vitest run --config ${UNCACHED_TIER_CONFIG} ${test}`,
  );
}

export function lintOkRulesFixture(fixtureRel: string): OkRulesFixtureDiagnostic[] {
  const lint: OkRulesFixtureLint | undefined = inject('okRulesFixtureLint');
  if (lint === undefined) throw outsideTheTier();
  if ('error' in lint) throw new Error(lint.error);
  return lint.diagnostics
    .filter((diagnostic) => diagnostic.filename === fixtureRel)
    .map((diagnostic) => {
      const span = diagnostic.labels?.[0]?.span;
      if (typeof diagnostic.code !== 'string') {
        throw new Error(
          `read-ok-rules-config: oxlint reported a diagnostic on ${fixtureRel} that names no rule, so a rule threw while linting it or oxlint could not parse it. oxlint says:\n${diagnostic.message ?? '(no message)'}\nFull diagnostic: ${JSON.stringify(diagnostic)}`,
        );
      }
      if (
        typeof diagnostic.message !== 'string' ||
        typeof span?.line !== 'number' ||
        typeof span.column !== 'number'
      ) {
        throw new Error(
          `read-ok-rules-config: oxlint reported a ${diagnostic.code} diagnostic on ${fixtureRel} without a message or position: ${JSON.stringify(diagnostic)}`,
        );
      }
      return {
        code: diagnostic.code,
        position: positionOf(span.line, span.column),
        message: diagnostic.message,
      };
    })
    .sort(comparePositions);
}

interface OxlintConfig {
  jsPlugins?: Array<string | { name?: string; specifier: string }>;
  rules?: Record<string, unknown>;
}

const OXLINT_CONFIG = 'oxlint.config.ts';
const OK_RULES_INDEX = 'lint-plugins/ok-rules/index.mjs';

type ReadModule = typeof OXLINT_CONFIG | typeof OK_RULES_INDEX;

function required<T>(
  value: T | undefined,
  { module, exportName }: { module: ReadModule; exportName: string },
): T {
  if (value === undefined) {
    throw new Error(
      `read-ok-rules-config: ${module} exposes no \`${exportName}\`. Substituting an empty ` +
        'value would report every rule as unregistered, so this fails loudly instead.',
    );
  }
  return value;
}

async function loadOxlintConfig(repoRoot: string): Promise<OxlintConfig> {
  const url = pathToFileURL(join(repoRoot, OXLINT_CONFIG)).href;
  const mod = (await import(/* @vite-ignore */ url)) as { default?: OxlintConfig };
  return required(mod.default, { module: OXLINT_CONFIG, exportName: 'default export' });
}

export async function readEnabledRuleIds(repoRoot: string): Promise<string[]> {
  const config = await loadOxlintConfig(repoRoot);
  const rules = required(config.rules, { module: OXLINT_CONFIG, exportName: 'rules' });
  return Object.entries(rules)
    .filter(([id, severity]) => /^ok(?:-private)?\//.test(id) && severity === 'error')
    .map(([id]) => id);
}

export async function readJsPluginSpecifiers(repoRoot: string): Promise<string[]> {
  const config = await loadOxlintConfig(repoRoot);
  const jsPlugins = required(config.jsPlugins, { module: OXLINT_CONFIG, exportName: 'jsPlugins' });
  return jsPlugins.map((entry) => (typeof entry === 'string' ? entry : entry.specifier));
}

export async function readRegisteredRuleNames(repoRoot: string): Promise<string[]> {
  const url = pathToFileURL(join(repoRoot, OK_RULES_INDEX)).href;
  const { rules } = (await import(/* @vite-ignore */ url)) as {
    rules?: Record<string, unknown>;
  };
  return Object.keys(required(rules, { module: OK_RULES_INDEX, exportName: 'rules' }));
}

export function readRuleScope(_repoRoot: string, ruleName: string): string[] {
  return [...((RULE_SCOPES as Record<string, string[]>)[ruleName] ?? [])];
}
