export interface UtilityForkEnvOptions {
  startupTraceparent?: string;
  otlpEndpoint?: string;
}

export function buildUtilityForkEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  opts: UtilityForkEnvOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    OK_ELECTRON_PROTOCOL_HOST: '1',
    OK_LOCK_KIND: 'interactive',
  };
  if (opts.startupTraceparent !== undefined) {
    env.OK_STARTUP_TRACEPARENT = opts.startupTraceparent;
  }
  if (opts.otlpEndpoint !== undefined) {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = opts.otlpEndpoint;
  }
  return env;
}
