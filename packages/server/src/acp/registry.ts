import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import type { EditorId } from '@inkeep/open-knowledge-core';
import type { PinoLogger } from '../logger.ts';

const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export const FEATURED_AGENT_IDS: readonly string[] = [
  'claude-acp',
  'codex-acp',
  'gemini',
  'cursor',
  'github-copilot-cli',
  'opencode',
];

export const ACP_AGENT_EDITOR_IDS: { readonly [agentId: string]: EditorId | undefined } = {
  'claude-acp': 'claude',
  'codex-acp': 'codex',
  opencode: 'opencode',
  'pi-acp': 'pi',
};

export interface RegistryBinaryTarget {
  archive: string;
  sha256?: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RegistryPackageDistribution {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RegistryDistribution {
  npx?: RegistryPackageDistribution;
  uvx?: RegistryPackageDistribution;
  binary?: Record<string, RegistryBinaryTarget>;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution: RegistryDistribution;
}

export interface CustomAgentEntry {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CatalogResult {
  agents: RegistryAgent[];
  fetchedAt: number;
  stale: boolean;
}

const CUSTOM_AGENTS_FILE = 'acp-agents.json';
const REGISTRY_CACHE_FILE = 'acp-registry-cache.json';
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function registryPlatformKey(): string | null {
  const os = platform();
  const cpu = arch();
  const osKey =
    os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : os === 'win32' ? 'windows' : null;
  const cpuKey = cpu === 'arm64' ? 'aarch64' : cpu === 'x64' ? 'x86_64' : null;
  if (osKey === null || cpuKey === null) return null;
  return `${osKey}-${cpuKey}`;
}

const LOWERCASE_BRAND_AGENT_IDS: ReadonlySet<string> = new Set(['goose', 'fast-agent', 'crow-cli']);

export function normalizeAgentDisplayName(id: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return id;
  if (LOWERCASE_BRAND_AGENT_IDS.has(id)) return trimmed;
  if (trimmed !== trimmed.toLowerCase()) return trimmed;
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isRegistryAgent(value: unknown): value is RegistryAgent {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    a.id.length > 0 &&
    typeof a.name === 'string' &&
    typeof a.version === 'string' &&
    typeof a.distribution === 'object' &&
    a.distribution !== null
  );
}

function parseCatalogJson(text: string): RegistryAgent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const agents = (parsed as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return null;
  return agents
    .filter(isRegistryAgent)
    .map((agent) => ({ ...agent, name: normalizeAgentDisplayName(agent.id, agent.name) }));
}

export class AcpRegistry {
  private readonly localDir: string;
  private readonly log: PinoLogger;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private memory: CatalogResult | null = null;
  private inflight: Promise<CatalogResult> | null = null;

  constructor(opts: {
    localDir: string;
    log: PinoLogger;
    ttlMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.localDir = opts.localDir;
    this.log = opts.log;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getCatalog(): Promise<CatalogResult> {
    if (
      this.memory !== null &&
      Date.now() - this.memory.fetchedAt < this.ttlMs &&
      !this.memory.stale
    ) {
      return this.memory;
    }
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async getAgent(id: string): Promise<RegistryAgent | undefined> {
    const { agents } = await this.getCatalog();
    return agents.find((a) => a.id === id);
  }

  private async refresh(): Promise<CatalogResult> {
    try {
      const res = await this.fetchImpl(ACP_REGISTRY_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`registry fetch failed: HTTP ${res.status}`);
      const text = await res.text();
      const agents = parseCatalogJson(text);
      if (agents === null) throw new Error('registry payload did not parse as a catalog');
      this.memory = { agents, fetchedAt: Date.now(), stale: false };
      try {
        const { tracedMkdir, tracedWriteFile } = await import('../fs-traced.ts');
        await tracedMkdir(this.localDir, { recursive: true });
        await tracedWriteFile(join(this.localDir, REGISTRY_CACHE_FILE), text);
      } catch (err) {
        this.log.warn({ err }, '[acp-registry] disk cache write failed');
      }
      return this.memory;
    } catch (err) {
      const fallback = await this.readDiskCache();
      if (fallback !== null) {
        this.log.warn({ err }, '[acp-registry] CDN unreachable — serving disk cache');
        this.memory = fallback;
        return fallback;
      }
      if (this.memory !== null) {
        this.log.warn({ err }, '[acp-registry] CDN unreachable — serving stale memory copy');
        this.memory = { ...this.memory, stale: true };
        return this.memory;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async readDiskCache(): Promise<CatalogResult | null> {
    try {
      const text = await readFile(join(this.localDir, REGISTRY_CACHE_FILE), 'utf8');
      const agents = parseCatalogJson(text);
      if (agents === null) return null;
      return { agents, fetchedAt: 0, stale: true };
    } catch {
      return null;
    }
  }
}

export async function loadCustomAgents(
  localDir: string,
  log: PinoLogger,
): Promise<CustomAgentEntry[]> {
  let text: string;
  try {
    text = await readFile(join(localDir, CUSTOM_AGENTS_FILE), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn({ err }, `[acp-registry] ${CUSTOM_AGENTS_FILE} is not valid JSON — ignoring`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const valid: CustomAgentEntry[] = [];
  for (const entry of parsed) {
    const e = entry as Record<string, unknown>;
    if (
      typeof e?.id === 'string' &&
      /^[a-zA-Z0-9_-]+$/.test(e.id) &&
      typeof e.name === 'string' &&
      typeof e.command === 'string' &&
      e.command.length > 0 &&
      (e.args === undefined ||
        (Array.isArray(e.args) && e.args.every((a) => typeof a === 'string'))) &&
      (e.env === undefined ||
        (typeof e.env === 'object' &&
          e.env !== null &&
          !Array.isArray(e.env) &&
          Object.values(e.env).every((v) => typeof v === 'string')))
    ) {
      valid.push({
        id: e.id,
        name: e.name,
        command: e.command,
        args: e.args as string[] | undefined,
        env: (e.env as Record<string, string> | undefined) ?? undefined,
      });
    } else {
      log.warn({ entry }, `[acp-registry] dropping malformed ${CUSTOM_AGENTS_FILE} entry`);
    }
  }
  return valid;
}
