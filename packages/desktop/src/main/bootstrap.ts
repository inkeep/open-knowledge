import type { OkThemeSource } from '../shared/bridge-contract.ts';
import type { AppState, SchemaIncompatibilityDiagnostic } from './state-store.ts';

type SchemaCompatibilityResult =
  | { status: 'ok' }
  | { status: 'incompatible'; diagnostic: SchemaIncompatibilityDiagnostic };

interface BootstrapDeps {
  loadAppState: () => AppState;
  evaluateSchemaCompatibility: (
    state: AppState,
    maxSupported: number,
    currentBuild: string,
  ) => SchemaCompatibilityResult;
  installLocalhostCorsInjector: () => void;
  installEmbedRefererRewriter: () => void;
  registerIpcHandlers: () => void;
  setNativeThemeSource: (source: OkThemeSource) => void;
  refreshApplicationMenu: () => void;
  installDockIcon: () => void;
  log: { warn: (msg: string, obj?: unknown) => void };
  appVersion: string;
  maxSupportedSchemaVersion: number;
}

interface BootstrapResult {
  appState: AppState;
  pendingSchemaIncompatibility: SchemaIncompatibilityDiagnostic | null;
}

export async function runBootstrap(deps: BootstrapDeps): Promise<BootstrapResult> {
  const appState = deps.loadAppState();

  let pendingSchemaIncompatibility: SchemaIncompatibilityDiagnostic | null = null;
  const compat = deps.evaluateSchemaCompatibility(
    appState,
    deps.maxSupportedSchemaVersion,
    deps.appVersion,
  );
  if (compat.status === 'incompatible') {
    pendingSchemaIncompatibility = compat.diagnostic;
    deps.log.warn('[main] schemaVersion incompatibility detected', compat.diagnostic);
  }

  deps.installLocalhostCorsInjector();
  deps.installEmbedRefererRewriter();

  deps.registerIpcHandlers();

  deps.setNativeThemeSource('system');

  deps.refreshApplicationMenu();
  deps.installDockIcon();

  return { appState, pendingSchemaIncompatibility };
}
