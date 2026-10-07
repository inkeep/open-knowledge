export const FILE_BRIDGE_ROUTE = '/__ok-browser-file-bridge';

export type FileBridgeOperation = 'read' | 'exists' | 'readdir' | 'host';

export type BridgeHostFacts = {
  readonly cwd: string;
  readonly platform: string;
  readonly tmpdir: string;
  readonly eol: string;
  readonly ci: string | null;
};
