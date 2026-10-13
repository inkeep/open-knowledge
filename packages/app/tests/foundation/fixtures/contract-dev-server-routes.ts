export const CONTRACT_SERVER_EXIT_PATH = '/__contract-server/exit';
export const CONTRACT_SERVER_FORGE_PATH = '/__contract-server/forge-identity';
export const CONTRACT_SERVER_FAIL_READINESS_PATH = '/__contract-server/fail-readiness';
export const CONTRACT_SERVER_RESTART_PATH = '/__contract-server/restart';
export const CONTRACT_SERVER_GENERATION_PATH = '/__contract-server/generation';
export const CONTRACT_SERVER_EXCLUSIVE_RESOURCE_ENV = 'OK_CONTRACT_SERVER_EXCLUSIVE_RESOURCE';

export const CONTRACT_SERVER_READINESS_CHECKS = ['api-config', 'collab'] as const;

export type ContractServerReadinessCheck = (typeof CONTRACT_SERVER_READINESS_CHECKS)[number];

export function isContractServerReadinessCheck(
  value: string,
): value is ContractServerReadinessCheck {
  return (CONTRACT_SERVER_READINESS_CHECKS as readonly string[]).includes(value);
}
