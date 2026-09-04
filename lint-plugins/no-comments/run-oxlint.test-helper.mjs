import { spawnSync } from 'node:child_process';

const RULE_CODE = 'no-comments(no-comments)';
const LOAD_FAILURES = ['Failed to load JS plugin', 'Failed to load config', 'Failed to parse'];

export function runOxlint({ bin, cwd, config, target, code = RULE_CODE }) {
  const args = ['-c', config, target, '--format=json'];
  const result = spawnSync(bin, args, { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const raw = `${stdout}\n${stderr}`;
  const context = `${bin} ${args.join(' ')} (cwd ${cwd})\n${raw}`;

  if (result.error) throw new Error(`oxlint did not run: ${result.error.message}\n${context}`);
  if (result.signal) throw new Error(`oxlint was killed by ${result.signal}\n${context}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`oxlint exited ${result.status}, so its verdict is unusable\n${context}`);
  }
  for (const failure of LOAD_FAILURES) {
    if (raw.includes(failure)) throw new Error(`oxlint reported "${failure}"\n${context}`);
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`oxlint --format=json did not emit parseable JSON\n${context}`, { cause });
  }
  if (!Array.isArray(report.diagnostics)) {
    throw new Error(`oxlint --format=json emitted no diagnostics array\n${context}`);
  }
  if (result.status === 1 && report.diagnostics.length === 0) {
    throw new Error(`oxlint exited 1 without emitting a diagnostic, so it errored\n${context}`);
  }

  const diagnostics = [];
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.code !== code) continue;
    const span = diagnostic.labels?.[0]?.span;
    if (!span) throw new Error(`diagnostic without a span: ${diagnostic.message}\n${context}`);
    diagnostics.push({
      line: span.line,
      column: span.column,
      message: diagnostic.message,
      class: diagnostic.message.split(':')[0],
      code: diagnostic.code,
    });
  }
  return { status: result.status, raw, diagnostics };
}
