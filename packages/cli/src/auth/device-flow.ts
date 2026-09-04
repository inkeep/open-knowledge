import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device';

interface DeviceFlowVerification {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

interface DeviceFlowResult {
  token: string;
  tokenType: string;
  scopes: string[];
}

type OnVerification = (verification: DeviceFlowVerification) => void | Promise<void>;

interface DeviceFlowOptions {
  clientId: string;
  scopes?: string[];
  host?: string;
  onVerification: OnVerification;
}

export async function runDeviceFlow(options: DeviceFlowOptions): Promise<DeviceFlowResult> {
  const { clientId, scopes = ['repo', 'read:user', 'user:email'], onVerification, host } = options;

  const baseUrl =
    host && host !== 'github.com' ? `https://${host}/api/v3` : 'https://api.github.com';

  const auth = createOAuthDeviceAuth({
    clientType: 'oauth-app',
    clientId,
    scopes,
    onVerification: async (v) => {
      await onVerification({
        verificationUri: v.verification_uri,
        userCode: v.user_code,
        expiresIn: v.expires_in,
        interval: v.interval,
      });
    },
    request:
      baseUrl !== 'https://api.github.com'
        ? (await import('@octokit/request')).request.defaults({
            baseUrl,
          })
        : undefined,
  });

  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth({ type: 'oauth' });
  } catch (error) {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('access_denied')) {
        throw new Error('Device-flow authorization was denied.');
      }
      if (msg.includes('expired_token') || msg.includes('timeout') || msg.includes('timed out')) {
        throw new Error('Device-flow code expired before authorization — please try again.');
      }
      throw new Error(`GitHub sign-in failed: ${error.message}`);
    }
    throw error;
  }
  return {
    token: result.token,
    tokenType: result.tokenType,
    scopes: result.scopes ?? [],
  };
}
