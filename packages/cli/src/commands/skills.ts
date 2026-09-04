import { resolve as resolvePath } from 'node:path';
import { isDetectedSkillInProject } from '@inkeep/open-knowledge-core';
import { resolveProjectIdentity } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { enumerateInstalledSkills } from '@inkeep/open-knowledge-core/skills-catalog';
import { findEnclosingProjectRoot, resolveLockDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { accent, dim, error as errorColor, info, success } from '../ui/colors.ts';
import { inspectLock } from './lock-state.ts';

export function skillsCommand(): Command {
  const skills = new Command('skills').description(
    'Manage Open Knowledge skills for this project.',
  );

  skills
    .command('installed')
    .description('List every skill installed across all your agents (read-only).')
    .option('--json', 'Emit the raw enumeration as JSON.')
    .action((opts: { json?: boolean }) => {
      const cwd = resolvePath(process.cwd());
      const identity = resolveProjectIdentity(findEnclosingProjectRoot(cwd)?.rootPath ?? cwd);
      const enumerated = enumerateInstalledSkills({ projectDir: identity });
      const result = {
        ...enumerated,
        skills: enumerated.skills.filter((s) => isDetectedSkillInProject(s.provenance, identity)),
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (result.skills.length === 0) {
        process.stdout.write(`${dim('No installed skills found across any agent.')}\n`);
        return;
      }
      process.stdout.write(`${accent(`${result.skills.length} installed skill(s):`)}\n`);
      for (const s of result.skills) {
        const ver = s.provenance.version ? dim(` v${s.provenance.version}`) : '';
        const cap = [
          s.inert.commands && 'commands',
          s.inert.hooks && 'hooks',
          s.inert.mcp && 'mcp',
        ].filter(Boolean);
        const capStr = cap.length > 0 ? dim(` [${cap.join(', ')}]`) : '';
        process.stdout.write(
          `  ${success(s.name)}${ver}  ${dim(s.sourceHarnesses.join(', '))}${capStr}\n`,
        );
      }
      process.stdout.write(`\n${accent(`${result.packs.length} pack(s):`)}\n`);
      for (const p of result.packs) {
        process.stdout.write(
          `  ${info(p.name)} ${dim(`v${p.version}`)} — ${p.skills.length} skill(s)\n`,
        );
      }
    });

  skills
    .command('import <source>')
    .description(
      'Import a skill into this project as versioned content (github owner/repo, a git URL, or a local path).',
    )
    .option('--skill <name>', 'Pick one skill from a multi-skill source.')
    .option('--scope <scope>', 'project (default) or global.', 'project')
    .action(async (source: string, opts: { skill?: string; scope?: string }) => {
      const lockDir = resolveLockDir(process.cwd());
      const state = inspectLock(lockDir, 'server');
      if (state.status !== 'alive') {
        process.stderr.write(
          `${errorColor('Error:')} no running Open Knowledge server for this project. Start it with ${accent('ok start')} and retry.\n`,
        );
        process.exitCode = 1;
        return;
      }
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${state.lock.port}/api/skill/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source,
            ...(opts.skill ? { skill: opts.skill } : {}),
            scope: opts.scope === 'global' ? 'global' : 'project',
          }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${errorColor('Error:')} could not reach the server: ${msg}\n`);
        process.exitCode = 1;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const detail = (body.detail as string) ?? (body.title as string) ?? `HTTP ${res.status}`;
        process.stderr.write(`${errorColor('Import failed:')} ${detail}\n`);
        process.exitCode = 1;
        return;
      }
      const name = body.name as string;
      if (body.alreadyImported) {
        process.stdout.write(`${info('Already imported:')} ${accent(name)} (identical content).\n`);
        return;
      }
      const prov = (body.provenance ?? {}) as { source?: string; publisher?: string };
      const renamed = body.collisionRenamedFrom as string | undefined;
      process.stdout.write(
        `${success('Imported')} ${accent(name)}${renamed ? dim(` (renamed from ${renamed} — name was taken)`) : ''} from ${dim(prov.source ?? source)}${prov.publisher ? dim(` · ${prov.publisher}`) : ''}.\n` +
          `${dim("Saved as versioned content in this project's skill home. Scripts shown, never run. Use the skill's install menu (or the install MCP verb) to add it to your other editors.")}\n`,
      );
      for (const w of (body.warnings as string[]) ?? []) {
        process.stdout.write(`  ${dim(`! ${w}`)}\n`);
      }
    });

  return skills;
}
