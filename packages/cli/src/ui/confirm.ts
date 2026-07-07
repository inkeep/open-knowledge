import { createInterface } from 'node:readline/promises';

/**
 * A destructive-action confirmation prompt where empty input (a bare Enter)
 * defaults to **No** — the safe default for irreversible operations (matches
 * `diagnose bundle`'s `isAffirmative`). Only `y` / `yes` (case-insensitive,
 * trimmed) confirm.
 *
 * The prompt is written to stderr so a `--json` stdout stream stays clean.
 * `input` is injectable for tests (defaults to `process.stdin`).
 */
export async function confirmDestructive(
  prompt: string,
  input?: NodeJS.ReadableStream,
): Promise<boolean> {
  const rl = createInterface({ input: input ?? process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
