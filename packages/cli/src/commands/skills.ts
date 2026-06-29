
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
