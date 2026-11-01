import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { bootCompositionRig } from '../../../server/src/composition-rig.test-helper.ts';
import { skillsCommand } from './skills.ts';

test('CLI import prints the server refusal remedy together with its diagnostic code', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ok-cli-skill-refusal-'));
  const root = join(fixture, 'project');
  const upstream = join(fixture, 'upstream', 'blocked-cli');
  const outside = join(fixture, 'outside');
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  mkdirSync(upstream, { recursive: true });
  mkdirSync(outside);
  writeFileSync(
    join(upstream, 'SKILL.md'),
    '---\nname: blocked-cli\ndescription: Fixture\n---\nBody\n',
  );
  writeFileSync(join(outside, 'sentinel.txt'), 'outside sentinel');
  symlinkSync(outside, join(root, '.claude/skills/blocked-cli'), 'junction');
  const server = await bootCompositionRig(root);
  try {
    await server.ready;
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await skillsCommand().parseAsync(['import', upstream], { from: 'user' });
    const line = stderr.mock.calls
      .map(([text]) => String(text))
      .join('')
      .split('\n')
      .find((text) => text.includes('Import failed:'));
    expect(line).toContain('replace the link');
    expect(line).toContain('SKILL_PATH_OUTSIDE_HOME');
    expect(process.exitCode).toBe(1);
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(false);
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await server.destroy();
    rmSync(fixture, { recursive: true, force: true });
  }
});
