
export interface AgentIdentity {
  connectionId: string;
  clientInfo?: {
    name: string;
    version: string;
  };
  displayName: string;
  colorSeed: string;
}

export const MCP_CONNECTION_ID_HEADER = 'x-ok-connection-id';

export function sanitizeClientName(name: string | undefined, fallback: string): string {
  const clean = Array.from(name ?? '')
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, 128) : fallback;
}
