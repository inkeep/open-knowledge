import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { readConfigSafely } from '../../config/read-config-safely.ts';
import { resolveConfigPath } from '../../config/write-config-patch.ts';
import { classifyHost, isPublicUnicastIp } from '../../util/ip-classifier.ts';
import { SkillDestinationPolicyError } from './errors.ts';

class NonPublicSkillAddressError extends Error {}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 4);
      return;
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicUnicastIp(address))) {
      callback(new NonPublicSkillAddressError(), '', 4);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

const publicDispatcher = new Agent({ connect: { lookup: publicLookup } });

export async function fetchWebsiteSkill(url: string, init: RequestInit): Promise<Response> {
  const target = new URL(url);
  const config = readConfigSafely({
    absPath: resolveConfigPath('user', '.'),
    sideline: false,
    warn: () => {},
  });
  const configurationInvalid =
    !config.valid ||
    config.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'VALUE_FALLBACK' &&
        diagnostic.issues.some(
          (issue) => issue.path[0] === 'skills' && issue.path[1] === 'trustedPrivateOrigins',
        ),
    );
  const trusted = config.value.skills.trustedPrivateOrigins.includes(target.origin);
  const host = classifyHost(target.hostname);
  if (!trusted && host.kind === 'ip-literal' && !host.allowed) {
    throw new SkillDestinationPolicyError(target.origin, configurationInvalid);
  }
  const requestInit = trusted ? init : { ...init, dispatcher: publicDispatcher };
  try {
    return await globalThis.fetch(url, requestInit);
  } catch (error) {
    if (error instanceof Error && error.cause instanceof NonPublicSkillAddressError) {
      throw new SkillDestinationPolicyError(target.origin, configurationInvalid);
    }
    throw error;
  }
}
