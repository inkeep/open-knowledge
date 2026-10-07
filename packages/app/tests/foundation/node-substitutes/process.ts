import { hostFacts } from './file-bridge';

export const env: Readonly<Record<string, string | undefined>> = {
  CI: hostFacts().ci ?? undefined,
};

export function cwd(): string {
  return hostFacts().cwd;
}

export const platform = hostFacts().platform;

export function exit(code?: number): never {
  throw new Error(`process.exit(${code ?? ''}) was called in the browser tier`);
}

export default { env, cwd, platform, exit };
