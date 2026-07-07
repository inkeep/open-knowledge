import { afterEach, describe, expect, test } from 'bun:test';
import { makeTree } from './migrate/notion/mktree.test-helper.ts';
import { migrateCommand } from './migrate.ts';

const ID = '30545f35b5ad80a38049d283dae66763';
const R1 = '11111111111111111111111111111111';
const R2 = '22222222222222222222222222222222';

/** Run the `notion` subcommand and return the resulting process exit code. */
async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  process.exitCode = 0;
  const originalLog = console.log;
  const originalErr = console.error;
  let stdout = '';
  console.log = (msg?: unknown) => {
    stdout += `${String(msg)}\n`;
  };
  console.error = () => {};
  try {
    await migrateCommand().parseAsync(['notion', ...args], { from: 'user' });
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0; // do not leak into the test runner's own exit
  return { code, stdout };
}

afterEach(() => {
  process.exitCode = 0;
});

describe('ok migrate notion — exit codes', () => {
  test('exit 2 for an unknown --only transform', async () => {
    const root = makeTree({ 'page.md': '# P\n' });
    expect((await run([root, '--only', 'bogus'])).code).toBe(2);
  });

  test('exit 2 for a directory that is not a Notion export', async () => {
    const root = makeTree({ 'notes.md': '# Notes\n\nPlain.\n' });
    expect((await run([root])).code).toBe(2);
  });

  test('exit 2 with a machine-readable refusal on --json', async () => {
    const root = makeTree({ 'notes.md': '# Notes\n' });
    const { code, stdout } = await run([root, '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ refused: true, reason: 'not-a-notion-export' });
  });

  test('exit 1 when there is nothing to do', async () => {
    const root = makeTree({ [`Clean ${ID}.md`]: '# Clean\n\nNo links here.\n' });
    expect((await run([root])).code).toBe(1);
  });

  test('exit 0 for a dry-run that has changes to preview', async () => {
    const root = makeTree({ [`Home ${ID}.md`]: '# Home\n\n[x](Foo%20Bar.md)\n' });
    expect((await run([root])).code).toBe(0);
  });

  test('exit 3 when --apply completes with ambiguous title links', async () => {
    const root = makeTree({
      [`DB ${ID}_all.csv`]: 'Title,X\nNotes,1\nNotes,2\n',
      [`DB/Notes ${R1}.md`]: '# Notes\n',
      [`DB/Notes ${R2}.md`]: '# Notes\n',
    });
    expect((await run([root, '--apply'])).code).toBe(3);
  });

  test('exit 3 when --apply produces a wide table (>15 columns)', async () => {
    const header = Array.from({ length: 16 }, (_, i) => `C${i}`).join(',');
    const row = Array.from({ length: 16 }, (_, i) => `v${i}`).join(',');
    const root = makeTree({ [`DB ${ID}_all.csv`]: `${header}\n${row}\n` });
    expect((await run([root, '--apply'])).code).toBe(3);
  });
});
