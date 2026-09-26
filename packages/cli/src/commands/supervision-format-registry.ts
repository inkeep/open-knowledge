import { type Command, Option } from 'commander';
import { type JsonWriterDeps, writeJsonDocument } from './supervision-json-output.ts';

export const SUPERVISION_COMMANDS = ['status', 'ps', 'stop', 'clean'] as const;

export type SupervisionCommand = (typeof SUPERVISION_COMMANDS)[number];

export interface SupervisionContext {
  project: {
    root: string | null;
    resolution: 'enclosing-project' | 'cwd' | 'unavailable';
  };
  failure: string | null;
}

export type SupervisionRequest =
  | { command: 'status'; context: SupervisionContext }
  | { command: 'ps'; context: SupervisionContext }
  | { command: 'stop'; context: SupervisionContext; target: string | undefined; force: boolean }
  | { command: 'clean'; context: SupervisionContext };

export interface SupervisionResult {
  document: unknown;
  exitCode: 0 | 1;
}

export interface SupervisionFormatStrategy {
  format: string;
  requiresProjectConfig(command: SupervisionCommand, args: readonly string[]): boolean;
  execute(request: SupervisionRequest): Promise<SupervisionResult>;
}

export function isSupervisionCommand(value: string): value is SupervisionCommand {
  return SUPERVISION_COMMANDS.some((command) => command === value);
}

export class SupervisionFormatRegistry {
  private readonly strategies: Map<string, SupervisionFormatStrategy>;
  private readonly writerDeps: JsonWriterDeps;

  constructor(strategies: readonly SupervisionFormatStrategy[], writerDeps: JsonWriterDeps = {}) {
    this.strategies = new Map();
    this.writerDeps = writerDeps;
    for (const strategy of strategies) {
      if (!strategy.format || this.strategies.has(strategy.format)) {
        throw new Error(`Invalid or duplicate supervision format: ${strategy.format}`);
      }
      this.strategies.set(strategy.format, strategy);
    }
  }

  get(format: unknown): SupervisionFormatStrategy | undefined {
    return typeof format === 'string' ? this.strategies.get(format) : undefined;
  }

  select(
    command: string,
    format: unknown,
  ): { command: SupervisionCommand; strategy: SupervisionFormatStrategy } | undefined {
    const strategy = this.get(format);
    return isSupervisionCommand(command) && strategy ? { command, strategy } : undefined;
  }

  addFormatOption(command: Command, legacyJson = false): Command {
    const option = new Option(
      '--format <value>',
      'Emit the versioned supervision JSON document',
    ).choices([...this.strategies.keys()]);
    if (legacyJson) option.conflicts('json');
    return command.addOption(option);
  }

  async execute(format: string, request: SupervisionRequest): Promise<boolean> {
    const strategy = this.get(format);
    if (!strategy) throw new Error(`Unsupported supervision format: ${format}`);
    const result = await strategy.execute(request);
    return writeJsonDocument(result.document, result.exitCode, this.writerDeps);
  }
}
