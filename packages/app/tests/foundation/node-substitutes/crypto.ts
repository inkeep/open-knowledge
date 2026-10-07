export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export const webcrypto = globalThis.crypto;

export default { randomUUID, webcrypto };
