import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error untyped ESM lint-plugin module
import { RULE_SCOPES } from '../lint-plugins/ok-rules/scope.mjs';

const OK_RULES_FIXTURE_CONFIG = 'lint-plugins/ok-rules/__fixtures__/oxlint.fixtures.json';

export function oxlintFixtureArgs(fixtureRel: string): string[] {
  return ['exec', 'oxlint', '-f', 'json', '-c', OK_RULES_FIXTURE_CONFIG, fixtureRel];
}

export interface OxlintDiagnostic {
  message: string;
  code: string;
  filename: string;
  labels?: Array<{ span?: { line?: number; column?: number } }>;
}

export function parseOxlintDiagnostics(output: string): OxlintDiagnostic[] {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  return (JSON.parse(output.slice(start, end + 1)).diagnostics ?? []) as OxlintDiagnostic[];
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
  return (RULE_SCOPES as Record<string, string[]>)[ruleName] ?? [];
}
