
export function buildUtilityForkEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    OK_ELECTRON_PROTOCOL_HOST: '1',
    OK_LOCK_KIND: 'interactive',
  };
}
