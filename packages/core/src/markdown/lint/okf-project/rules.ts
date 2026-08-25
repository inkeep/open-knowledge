import { SUPPORTED_DOC_EXTENSIONS } from '../../../constants/doc-extensions.ts';
import { isOkfRuleEnabled, type OkfRuleId, type OkfRuleToggles } from '../okf-rule-meta.ts';

export interface OkfProjectFinding {
  readonly file: string;
  readonly code: OkfRuleId;
  readonly message: string;
}

function splitName(path: string): { stem: string; ext: string } {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return { stem: base, ext: '' };
  return { stem: base.slice(0, dot), ext: base.slice(dot) };
}

function noMdx(paths: readonly string[]): OkfProjectFinding[] {
  const mdStems = new Set(
    paths
      .filter((path) => splitName(path).ext.toLowerCase() === '.md')
      .map((path) => path.slice(0, path.lastIndexOf('.'))),
  );
  const findings: OkfProjectFinding[] = [];
  for (const path of paths) {
    if (splitName(path).ext.toLowerCase() !== '.mdx') continue;
    const stem = path.slice(0, path.lastIndexOf('.'));
    const lead = `"${path}" won't be picked up by an Open Knowledge Format consumer — the format is .md-only, and nothing scanning for .md files will open an .mdx.`;
    findings.push({
      file: path,
      code: 'project-no-mdx',
      message: mdStems.has(stem)
        ? `${lead} It is also shadowed by "${stem}.md", so a consumer reads that file instead and gets different content than this project shows you.`
        : lead,
    });
  }
  return findings;
}

export interface OkfProjectRule {
  readonly id: OkfRuleId;
  readonly run: (paths: readonly string[]) => OkfProjectFinding[];
}

export const OKF_PROJECT_REGISTRY: readonly OkfProjectRule[] = [
  { id: 'project-no-mdx', run: noMdx },
];

export function runOkfProjectRules(
  paths: readonly string[],
  rules: OkfRuleToggles,
): OkfProjectFinding[] {
  const docs = paths.filter((path) =>
    SUPPORTED_DOC_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext)),
  );
  if (docs.length === 0) return [];
  return OKF_PROJECT_REGISTRY.filter((rule) => isOkfRuleEnabled(rules, rule.id)).flatMap((rule) =>
    rule.run(docs),
  );
}
