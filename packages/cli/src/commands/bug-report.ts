import { spawn as childSpawn } from 'node:child_process';
import { platform } from 'node:os';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { getCliLogger } from '../cli.ts';
import { collectReportBundle } from '../report-bundle.ts';
import { defaultBugReportZipPath } from './bug-report-bundle.ts';

export function bugReportCommand(): Command {
  return new Command('bug-report')
    .description('Generate a diagnostic bundle for bug reporting')
    .option('--reveal', 'Reveal the bundle in Finder (default: true)', true)
    .option('--no-reveal', 'Do not reveal the bundle in Finder')
    .action(async (opts: { reveal: boolean }) => {
      try {
        const { zipPath, summary } = await collectReportBundle({
          level: 'standard',
          projectDir: process.cwd(),
          redact: true,
          outputPath: defaultBugReportZipPath(),
          logger: getCliLogger(),
        });

        process.stdout.write(`${zipPath}\n`);

        if (summary.redactedLineCount > 0) {
          process.stderr.write(
            `ok bug-report: ${summary.redactedLineCount} line(s) auto-redacted across ${summary.redactions.length} file(s)\n`,
          );
        }

        if (opts.reveal && platform() === 'darwin') {
          try {
            childSpawn(
              '/usr/bin/open',
              ['-R', zipPath],
              withHiddenWindowsConsole({ detached: true, stdio: 'ignore' as const }),
            ).unref();
          } catch {}
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ok bug-report: failed — ${msg}\n`);
        process.exitCode = 1;
      }
    });
}
