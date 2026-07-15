import { originGitHubHost } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { clearTokenFromAllBackends } from '../../auth/token-store.ts';

interface SignoutOptions {
  host: string;
}

async function runSignout(opts: SignoutOptions): Promise<void> {
  const { host } = opts;
  const { touched } = await clearTokenFromAllBackends(host);

  if (touched.length === 0) {
    process.stderr.write(`Not signed in to ${host}\n`);
    return;
  }

  process.stderr.write(`✓ Signed out from ${host}\n`);
  if (touched.includes('keychain')) {
    process.stderr.write(`  cleared from OS keychain\n`);
  }
  if (touched.includes('file')) {
    process.stderr.write(`  cleared from ~/.ok/auth.yml\n`);
  }
}

export function signoutCommand(): Command {
  return new Command('signout')
    .description('Remove stored credentials')
    .option(
      '--host <host>',
      'GitHub or GitHub Enterprise hostname (default: workspace origin host)',
    )
    .action(async (opts: Omit<SignoutOptions, 'host'> & { host?: string }) => {
      const host = opts.host ?? originGitHubHost(process.cwd());
      await runSignout({ ...opts, host });
    });
}
