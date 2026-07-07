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
  /** Host for GitHub Enterprise (default: 'github.com') */
  host?: string;
  onVerification: OnVerification;
}

/**
 * Run the GitHub OAuth Device Flow, calling onVerification with the user code
 * so the CLI can display it. Returns the access token on success.
 *
 * Throws on timeout or auth failure.
 */
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
    // Octokit's Device Flow throws for timeout, user denial, and network
    // errors. Propagating raw Octokit errors lands as a bare stack trace in
    // the CLI; remap to a message the `login` / `pat` commands can format.
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
