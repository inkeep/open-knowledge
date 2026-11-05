import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

const acquisitionFails = process.env.ACP_REPLAY_FAILURE === '1';

vi.mock('./package-acquisition.test-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./package-acquisition.test-helper.ts')>();
  return {
    ...actual,
    native: async (command: string, args: string[]) => {
      if (
        command !== 'curl' ||
        !args.includes('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json')
      ) {
        throw new Error(`Unfaked native request: ${command}`);
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          agents: [
            { ...actual.registryPackage('fixture-adapter@2.0.0'), id: 'fixture-live-adapter' },
          ],
        }),
        stderr: '',
      };
    },
    withLiveAcquisitionHome: async (run: (home: string) => Promise<void>) =>
      actual.withAcquisitionHome(async (home) => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        actual.installNodeFixture(bin);
        actual.writeExecutable(join(bin, 'npx'), 'process.exit(0);');
        actual.writeExecutable(
          join(bin, 'npm'),
          `
          const args = process.argv.slice(2);
          if (args[0] === 'view') {
            process.stdout.write(JSON.stringify({ '1.0.0': '2026-01-01T00:00:00.000Z', '2.0.0': '2026-01-10T00:00:00.000Z' }));
          } else if (${acquisitionFails}) {
            process.stderr.write('npm error E401 fixture registry refused acquisition');
            process.exitCode = 1;
          } else if (args[1] === 'fixture-adapter@2.0.0') {
            process.stderr.write('npm error ETARGET No matching version with a date before the cutoff');
            process.exitCode = 1;
          } else {
            process.stdout.write(JSON.stringify([{ name: 'fixture-adapter', version: '1.0.0' }]));
          }
        `,
        );
        process.env.PATH = bin;
        await run(home);
      }),
  };
});
