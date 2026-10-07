import { hostFacts } from './file-bridge';

export function tmpdir(): string {
  return hostFacts().tmpdir;
}

export function platform(): string {
  return hostFacts().platform;
}

export const EOL = hostFacts().eol;

export default { tmpdir, platform, EOL };
