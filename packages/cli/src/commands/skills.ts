/**
 * `ok skills manage --on | --off | --status` — the headless opt-in for
 * project-level skill management, mirroring the Desktop / `ok ui` prompt.
 *
 * `--on` flips the project to OK-managed (records `manageEditorSkills: true` in
 * `<project>/.ok/local/skill-management.json`): on the next `ok start` / project
 * open, `reconcileSkillInstalls` imports existing editor skills into `.ok/skills`
 * and adopts newly-installed ones thereafter. `--off` is non-destructive — it
 * stops future adoption; existing `.ok/skills` content + editor symlinks stay.
 * Skills that already have a `.ok/skills` entry are managed regardless of this
 * flag.
 */

import { resolve as resolvePath } from 'node:path';
import { isProjectSkillManaged, writeSkillManagement } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { accent, dim, error as errorColor, info, success } from '../ui/colors.ts';

export function skillsCommand(): Command {
  const skills = new Command('skills').description(
    'Manage Open Knowledge skills for this project.',
  );

  skills
    .command('manage')
    .description(
      'Control whether OK adopts your editor skills into this project. Default: off — OK only manages skills already under .ok/skills.',
    )
    .option(
      '--on',
      'Make this project OK-managed: import existing editor skills and adopt new ones.',
    )
    .option(
      '--off',
      'Stop adopting editor skills (non-destructive — existing .ok/skills + symlinks stay).',
    )
    .option('--status', 'Print the current setting.')
    .action(async (opts: { on?: boolean; off?: boolean; status?: boolean }) => {
      // No subcommand-level `--cwd`; the program-level `--cwd` preAction hook has
      // already chdir'd, so process.cwd() reflects the user's project.
      const projectDir = resolvePath(process.cwd());
      const chosen = [opts.on, opts.off, opts.status].filter(Boolean).length;
      if (chosen !== 1) {
        process.stderr.write(
          `${errorColor('Error:')} pass exactly one of --on, --off, --status.\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (opts.status) {
        // Effective state (honors the OK_RECLAIM_DISABLE / OK_SKILL_MANAGE env
        // overrides reconcile reads), not just the raw marker — this is the
        // surface people use to debug "why aren't my skills being adopted?".
        const managed = isProjectSkillManaged(projectDir);
        process.stdout.write(
          `Skill management for ${accent(projectDir)}: ${managed ? success('on') : dim('off (default)')}\n`,
        );
        return;
      }

      const manageEditorSkills = Boolean(opts.on);
      try {
        await writeSkillManagement(projectDir, { manageEditorSkills, surface: 'cli' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${errorColor('Error:')} could not write skill-management marker: ${msg}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        manageEditorSkills
          ? `${success('OK now manages skills for this project.')} Existing editor skills are imported into ${accent('.ok/skills')} on the next ${accent('ok start')} / project open, and new ones adopted automatically.\n`
          : `${info('OK will no longer adopt editor skills here.')} Existing ${accent('.ok/skills')} content + symlinks are left intact.\n`,
      );
    });

  return skills;
}
