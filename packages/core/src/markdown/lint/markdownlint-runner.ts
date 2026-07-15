import { applyFixes, type Configuration, type FixInfo, type LintError } from 'markdownlint';
import { lint } from 'markdownlint/sync';
import type { LintDiagnostic, LintTextEdit } from './types.ts';

const STRING_ID = 'doc';

export function fixMarkdownText(text: string, config: Configuration): string {
  const results = lint({ strings: { [STRING_ID]: text }, config });
  return applyFixes(text, results[STRING_ID] ?? []);
}

export function runMarkdownlint(text: string, config: Configuration): LintDiagnostic[] {
  const results = lint({ strings: { [STRING_ID]: text }, config });
  const errors = results[STRING_ID] ?? [];
  const lines = text.split('\n');
  const severities = buildSeverityIndex(config);
  return errors.map((error) => toDiagnostic(error, lines, severityFor(error, severities)));
}

type RuleSeverity = 'error' | 'warning';
type SeverityIndex = ReadonlyMap<string, { entryIndex: number; severity: RuleSeverity }>;

function buildSeverityIndex(config: Configuration): SeverityIndex {
  const map = new Map<string, { entryIndex: number; severity: RuleSeverity }>();
  Object.entries(config).forEach(([key, value], entryIndex) => {
    const upper = key.toUpperCase();
    if (upper === 'DEFAULT') return;
    let severity: RuleSeverity | null = null;
    if (value === 'error' || value === 'warning') {
      severity = value;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const s = (value as { severity?: unknown }).severity;
      if (s === 'error' || s === 'warning') severity = s;
    }
    if (severity !== null) map.set(upper, { entryIndex, severity });
  });
  return map;
}

function severityFor(error: LintError, severities: SeverityIndex): RuleSeverity {
  let governing: { entryIndex: number; severity: RuleSeverity } | undefined;
  for (const name of error.ruleNames) {
    const hit = severities.get(name.toUpperCase());
    if (hit !== undefined && (governing === undefined || hit.entryIndex > governing.entryIndex)) {
      governing = hit;
    }
  }
  return governing?.severity ?? 'warning';
}

function toDiagnostic(error: LintError, lines: string[], severity: RuleSeverity): LintDiagnostic {
  const [column, length] = error.errorRange ?? [1, null];
  const line = error.lineNumber - 1;
  const startCharacter = (column ?? 1) - 1;
  const lineLength = lines[line]?.length ?? 0;
  const endCharacter = length == null ? lineLength : Math.min(startCharacter + length, lineLength);
  const fixes = error.fixInfo ? [fixInfoToEdit(error.fixInfo, error.lineNumber, lines)] : undefined;
  return {
    range: {
      start: { line, character: startCharacter },
      end: { line, character: Math.max(endCharacter, startCharacter) },
    },
    severity,
    source: 'markdownlint',
    code: error.ruleNames[0] ?? 'MD000',
    message: error.errorDetail
      ? `${error.ruleDescription}: ${error.errorDetail}`
      : error.ruleDescription,
    ...(fixes ? { fixes } : {}),
  };
}

function fixInfoToEdit(fixInfo: FixInfo, diagnosticLine: number, lines: string[]): LintTextEdit {
  const lineNumber = fixInfo.lineNumber ?? diagnosticLine; // 1-based
  const line = lineNumber - 1;
  if (fixInfo.deleteCount === -1) {
    if (lineNumber < lines.length) {
      return {
        range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } },
        newText: '',
      };
    }
    if (line > 0) {
      const prevLength = lines[line - 1]?.length ?? 0;
      return {
        range: {
          start: { line: line - 1, character: prevLength },
          end: { line, character: lines[line]?.length ?? 0 },
        },
        newText: '',
      };
    }
    return {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: lines[0]?.length ?? 0 },
      },
      newText: '',
    };
  }
  const startCharacter = (fixInfo.editColumn ?? 1) - 1;
  return {
    range: {
      start: { line, character: startCharacter },
      end: { line, character: startCharacter + Math.max(0, fixInfo.deleteCount ?? 0) },
    },
    newText: fixInfo.insertText ?? '',
  };
}
