import { createInterface } from 'node:readline/promises';

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
