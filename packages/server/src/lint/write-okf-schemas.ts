import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isOkfRuleEnabled,
  OKF_FRONTMATTER_REGISTRY,
  OKF_SCHEMA_DIR,
  type OkfRuleToggles,
  renderOkfSchemaFiles,
} from '@inkeep/open-knowledge-core';
import {
  tracedMkdirSync,
  tracedRmdirSync,
  tracedRmSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import { getLogger } from '../logger.ts';

const IGNORE_LINE = 'okf/';

const IGNORE_BLOCK = `
# .ok/okf/ holds the OKF lint plugin's schemas, rendered from the plugin on
# boot so agents can read the contract they are told governs a document. A
# generated artifact — regenerated whenever the plugin's copy changes, and
# never read back — so it is not committed.
${IGNORE_LINE}
`;

function ensureGitignored(projectDir: string): void {
  const ignorePath = join(projectDir, '.ok', '.gitignore');
  let current: string;
  try {
    current = readFileSync(ignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger('okf-schemas').warn(
        { err: error, projectDir },
        '[okf] could not read .ok/.gitignore; generated schemas may show as untracked',
      );
    }
    return;
  }
  const alreadyIgnored = current.split('\n').some((line) => line.trim() === IGNORE_LINE);
  if (alreadyIgnored) return;
  tracedWriteFileSync(ignorePath, `${current.replace(/\n*$/, '\n')}${IGNORE_BLOCK}`, 'utf8');
  getLogger('okf-schemas').debug(
    { projectDir },
    '[okf] added okf/ to .ok/.gitignore so generated schemas stay uncommitted',
  );
}

export interface OkfSchemaState {
  readonly enabled?: boolean;
  readonly rules?: OkfRuleToggles;
}

const appliedSignatures = new Map<string, string>();

function schemaSignature(okf: OkfSchemaState | undefined): string {
  if (okf?.enabled !== true) return 'off';
  const disabled = OKF_FRONTMATTER_REGISTRY.filter(
    (entry) => !isOkfRuleEnabled(okf.rules, entry.id),
  ).map((entry) => entry.id);
  return `on:${disabled.sort().join(',')}`;
}

export function ensureOkfSchemaFiles(projectDir: string, okf: OkfSchemaState | undefined): void {
  const signature = schemaSignature(okf);
  if (appliedSignatures.get(projectDir) === signature) return;
  appliedSignatures.set(projectDir, signature);
  if (okf?.enabled === true) {
    writeOkfSchemaFiles(projectDir, okf.rules);
  } else {
    removeOkfSchemaFiles(projectDir);
  }
}

export function resetOkfSchemaWriteState(): void {
  appliedSignatures.clear();
}

export function writeOkfSchemaFiles(projectDir: string, rules?: OkfRuleToggles): string[] {
  const files = renderOkfSchemaFiles();
  const written: string[] = [];
  try {
    tracedMkdirSync(join(projectDir, OKF_SCHEMA_DIR), { recursive: true });
    for (const file of files) {
      const abs = join(projectDir, file.path);
      if (!isOkfRuleEnabled(rules, file.ruleId)) {
        tracedRmSync(abs, { force: true });
        continue;
      }
      let existing: string | null = null;
      try {
        existing = readFileSync(abs, 'utf8');
      } catch {
        existing = null;
      }
      if (existing !== file.contents) {
        tracedMkdirSync(dirname(abs), { recursive: true });
        tracedWriteFileSync(abs, file.contents, 'utf8');
      }
      written.push(file.path);
    }
    ensureGitignored(projectDir);
  } catch (error) {
    getLogger('okf-schemas').warn(
      { err: error, projectDir },
      '[okf] could not write schema files; the plugin still validates from its own copy',
    );
    return [];
  }
  return written;
}

function removeOkfSchemaFiles(projectDir: string): void {
  try {
    for (const file of renderOkfSchemaFiles()) {
      tracedRmSync(join(projectDir, file.path), { force: true });
    }
    tracedRmdirSync(join(projectDir, OKF_SCHEMA_DIR));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      getLogger('okf-schemas').warn(
        { err: error, projectDir },
        '[okf] could not remove generated schema files',
      );
    }
  }
}
