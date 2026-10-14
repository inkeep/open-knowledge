export const DESKTOP_PRODUCTS = {
  stable: {
    appId: 'com.inkeep.open-knowledge',
    productName: 'OpenKnowledge',
    packageName: '@inkeep/open-knowledge-desktop',
    linuxExecutableName: 'openknowledge',
    protocolScheme: 'openknowledge',
    linuxPackageNames: {
      deb: 'openknowledge',
      rpm: 'openknowledge',
    },
    retiredLinuxPackageNames: {
      deb: [],
      rpm: ['OpenKnowledge'],
    },
    cliCommandNames: ['ok', 'open-knowledge'],
    mcpServerName: 'open-knowledge',
    mcpChainTag: '',
    npmDistTag: 'latest',
    userHomeDirName: '.ok',
    keyringService: 'open-knowledge',
  },
  beta: {
    appId: 'com.inkeep.open-knowledge.beta',
    productName: 'OpenKnowledge Beta',
    packageName: 'openknowledge-beta-desktop',
    linuxExecutableName: 'openknowledge-beta',
    protocolScheme: 'openknowledge-beta',
    linuxPackageNames: {
      deb: 'openknowledge-beta',
      rpm: 'openknowledge-beta',
    },
    retiredLinuxPackageNames: {
      deb: ['openknowledge-beta-desktop'],
      rpm: ['openknowledge-beta-desktop'],
    },
    cliCommandNames: ['ok-beta', 'open-knowledge-beta'],
    mcpServerName: 'open-knowledge-beta',
    mcpChainTag: '-beta',
    npmDistTag: 'beta',
    userHomeDirName: '.ok-beta',
    keyringService: 'open-knowledge-beta',
  },
  dev: {
    appId: 'com.inkeep.open-knowledge.dev',
    productName: 'OpenKnowledge Dev',
    packageName: 'openknowledge-dev-desktop',
    linuxExecutableName: 'openknowledge-dev',
    protocolScheme: 'openknowledge-dev',
    linuxPackageNames: {
      deb: 'openknowledge-dev',
      rpm: 'openknowledge-dev',
    },
    retiredLinuxPackageNames: {
      deb: [],
      rpm: [],
    },
    cliCommandNames: ['ok-dev', 'open-knowledge-dev'],
    mcpServerName: 'open-knowledge-dev',
    mcpChainTag: '-dev',
    npmDistTag: 'latest',
    userHomeDirName: '.ok-dev',
    keyringService: 'open-knowledge-dev',
  },
} as const;

export type DesktopProductName = keyof typeof DESKTOP_PRODUCTS;
export type DesktopProduct = (typeof DESKTOP_PRODUCTS)[DesktopProductName];

export const PACKAGED_DESKTOP_PRODUCT_NAMES = [
  'stable',
  'beta',
] as const satisfies readonly DesktopProductName[];

export type PackagedDesktopProductName = (typeof PACKAGED_DESKTOP_PRODUCT_NAMES)[number];

export const DEV_CHANNEL = 'dev' satisfies DesktopProductName;

export function desktopWindowsExecutableName(product: DesktopProduct): string {
  return `${product.productName}.exe`;
}

export function desktopWindowsInstallDirNames(product: DesktopProduct): readonly string[] {
  return [product.packageName.replaceAll('/', ''), product.productName];
}

export const PRODUCT_NAME = DESKTOP_PRODUCTS.stable.productName;

export const OK_CHANNEL_ENV = 'OK_CHANNEL';

function isDesktopProductName(value: string): value is DesktopProductName {
  return Object.hasOwn(DESKTOP_PRODUCTS, value);
}

function channelOverride(env: Record<string, string | undefined>): string | undefined {
  return env[OK_CHANNEL_ENV]?.trim().toLowerCase() || undefined;
}

export function isDevChannel(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): boolean {
  return channelOverride(env) === DEV_CHANNEL;
}

export function defaultToDevChannel(env: Record<string, string | undefined>): void {
  if (channelOverride(env) === undefined) env[OK_CHANNEL_ENV] = DEV_CHANNEL;
}

export function desktopChannelLabel(channel: string): string {
  if (channel === 'stable') return `${PRODUCT_NAME} (Stable)`;
  return isDesktopProductName(channel)
    ? DESKTOP_PRODUCTS[channel].productName
    : `${PRODUCT_NAME} (${channel})`;
}

function executableBaseName(execPath: string): string {
  return (execPath.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '');
}

export function resolveDesktopProductName(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
  execPath: string = globalThis.process?.execPath ?? '',
): DesktopProductName {
  const override = channelOverride(env);
  if (override) {
    if (isDesktopProductName(override)) return override;
    throw new Error(
      `Unsupported ${OK_CHANNEL_ENV}=${JSON.stringify(override)}. Expected ${Object.keys(DESKTOP_PRODUCTS).join(' or ')}.`,
    );
  }
  const exe = executableBaseName(execPath);
  for (const name of PACKAGED_DESKTOP_PRODUCT_NAMES) {
    if (name === 'stable') continue;
    const product = DESKTOP_PRODUCTS[name];
    if (
      exe === product.linuxExecutableName ||
      exe === product.productName ||
      exe.startsWith(`${product.productName} `)
    ) {
      return name;
    }
  }
  return 'stable';
}

export function currentDesktopProduct(): DesktopProduct {
  return DESKTOP_PRODUCTS[resolveDesktopProductName()];
}

export function currentMcpServerName(): DesktopProduct['mcpServerName'] {
  return currentDesktopProduct().mcpServerName;
}

export function currentCliCommandName(): DesktopProduct['cliCommandNames'][0] {
  return currentDesktopProduct().cliCommandNames[0];
}

export function desktopProductForCliCommand(command: string | null | undefined): DesktopProduct {
  for (const product of Object.values(DESKTOP_PRODUCTS)) {
    if (product.cliCommandNames[0] === command) return product;
  }
  return DESKTOP_PRODUCTS.stable;
}

export const CHECKOUT_CLI_COMMAND = 'node <checkout>/packages/cli/dist/cli.mjs';

export const DEV_FALLBACK_CLI_REFUSAL = `This dev build has no built CLI, so it will not sign in, sign out, store a token, clone a project or start a project server through the installed OpenKnowledge (Stable) CLI. Run pnpm build in the checkout, then restart this dev build.`;

function isChannelKey(key: string): boolean {
  return key.toUpperCase() === OK_CHANNEL_ENV;
}

function carriesDevChannel(env: Readonly<Record<string, string | undefined>>): boolean {
  return Object.entries(env).some(
    ([key, value]) => isChannelKey(key) && value?.trim().toLowerCase() === DEV_CHANNEL,
  );
}

export function envWithoutDevChannel(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const dropChannel = carriesDevChannel(env);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || (dropChannel && isChannelKey(key))) continue;
    out[key] = value;
  }
  return out;
}

type EnvOverlay = Readonly<Record<string, string | undefined>>;

const STABLE_FALLBACK_REFUSED_COMMANDS: readonly (readonly string[])[] = [
  ['auth', 'login'],
  ['auth', 'pat'],
  ['auth', 'token'],
  ['auth', 'signout'],
  ['clone'],
  ['start'],
];

export interface HostCliInvocation {
  readonly cliArgs: readonly string[];
  readonly cliEnv?: EnvOverlay | undefined;
}

export interface OkCliSpawn {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export interface OkCliRunnerInvocation {
  readonly cliArgs: readonly string[];
  readonly cliEnv: EnvOverlay;
}

export interface OkCliRefusal {
  readonly refused: string;
}

export interface ResolveOkCliCommandInput {
  readonly host?: HostCliInvocation | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class OkCliCommand {
  readonly #argv: readonly [string, ...string[]];
  readonly #overlay: EnvOverlay;
  readonly #fallsBackToStable: boolean;

  private constructor(
    argv: readonly [string, ...string[]],
    overlay: EnvOverlay,
    fallsBackToStable: boolean,
  ) {
    this.#argv = argv;
    this.#overlay = overlay;
    this.#fallsBackToStable = fallsBackToStable;
  }

  static resolve(input: ResolveOkCliCommandInput = {}): OkCliCommand {
    const env = input.env ?? globalThis.process?.env ?? {};
    const [first, ...rest] = input.host?.cliArgs ?? [];
    const channel = resolveDesktopProductName(env);
    const released = (PACKAGED_DESKTOP_PRODUCT_NAMES as readonly DesktopProductName[]).includes(
      channel,
    );
    const hostCli = first !== undefined;
    const pinned = channel !== 'stable' && (hostCli || released);
    return new OkCliCommand(
      hostCli ? [first, ...rest] : ['open-knowledge'],
      { ...input.host?.cliEnv, ...(pinned ? { [OK_CHANNEL_ENV]: channel } : {}) },
      channel === DEV_CHANNEL && !hostCli,
    );
  }

  refusalFor(trailingArgs: readonly string[]): string | undefined {
    if (!this.#fallsBackToStable) return undefined;
    const refused = STABLE_FALLBACK_REFUSED_COMMANDS.some((prefix) =>
      prefix.every((part, index) => trailingArgs[index] === part),
    );
    return refused ? DEV_FALLBACK_CLI_REFUSAL : undefined;
  }

  runnerInvocation(trailingArgs: readonly string[]): OkCliRunnerInvocation | OkCliRefusal {
    const refused = this.refusalFor(trailingArgs);
    if (refused !== undefined) return { refused };
    return { cliArgs: [...this.#argv, ...trailingArgs], cliEnv: { ...this.#overlay } };
  }

  spawn(trailingArgs: readonly string[], baseEnv: EnvOverlay): OkCliSpawn | OkCliRefusal {
    const refused = this.refusalFor(trailingArgs);
    if (refused !== undefined) return { refused };
    const [command, ...args] = this.#argv;
    const env = envWithoutDevChannel(baseEnv);
    for (const [key, value] of Object.entries(this.#overlay)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return { command, args: [...args, ...trailingArgs], env };
  }

  stdioServer(trailingArgs: readonly string[]): OkCliSpawn {
    this.#assertNotRefused(trailingArgs);
    const [command, ...args] = this.#argv;
    return { command, args: [...args, ...trailingArgs], env: definedEntries(this.#overlay) };
  }

  shellCommand(trailingArgs: readonly string[], quote: (part: string) => string): string {
    this.#assertNotRefused(trailingArgs);
    const assignments = Object.entries(definedEntries(this.#overlay)).map(
      ([key, value]) => `${key}=${quote(value)}`,
    );
    return [...assignments, ...[...this.#argv, ...trailingArgs].map(quote)].join(' ');
  }

  #assertNotRefused(trailingArgs: readonly string[]): void {
    const refused = this.refusalFor(trailingArgs);
    if (refused !== undefined) throw new Error(refused);
  }
}

function definedEntries(overlay: EnvOverlay): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function userHomeDisplayPath(product: DesktopProduct, ...segments: string[]): string {
  return ['~', product.userHomeDirName, ...segments].join('/');
}
