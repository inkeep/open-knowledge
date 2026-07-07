/**
 * `open-knowledge preview` — read-only content scope inspection.
 *
 * Prints the same Content block that `init` writes after scaffolding, but
 * without side effects. Works pre-init (loads schema defaults), post-init
 * (loads `.ok/config.yml`), and after config edits — re-running is the cheap
 * way to verify a scope change (`.okignore` edit, `content.dir` update)
 * before restarting the server.
 */
import { type Config, resolveContentDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import type { PreviewResult } from '../content/preview.ts';

export function previewCommand(getConfig: () => Config): Command {
  return new Command('preview')
    .description('Show what content the watcher will track (read-only)')
    .action(async () => {
      const { previewContent, formatPreviewBlock } = await import('../content/preview.ts');
      const config = getConfig();
      const cwd = process.cwd();
      const contentDir = resolveContentDir(config, cwd);

      let result: PreviewResult;
      try {
        result = previewContent({
          projectDir: cwd,
          contentDir,
        });
      } catch (e) {
        console.error(`Content preview failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${formatPreviewBlock(result, cwd)}\n`);

      if (result.totalCount === 0 && result.warnings.length > 0) {
        process.exitCode = 1;
      }
    });
}
