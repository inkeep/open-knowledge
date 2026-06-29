import { context, trace } from '@opentelemetry/api';
import type { LoggerOptions, Logger as PinoLoggerInstance, TransportSingleOptions } from 'pino';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { PinoFileSink, type PinoFileSinkOpts } from './telemetry-file-sink.ts';

function otelMixin(): Record<string, unknown> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const ctx = span.spanContext();
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    trace_flags: ctx.traceFlags,
  };
}

function shouldColorize(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '') {
    return false;
  }
  return process.stdout.isTTY ?? false;
}

const VALID_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function logLevelRank(level: string): number {
  if (level === 'silent') return Number.POSITIVE_INFINITY;
  return pino.levels.values[level] ?? pino.levels.values.info;
}

function mostVerboseLevel(a: string, b: string): string {
  return logLevelRank(a) <= logLevelRank(b) ? a : b;
}

export interface PinoLoggerConfig {
  options?: LoggerOptions;
  transportConfigs?: TransportSingleOptions[];
  fileSink?: PinoFileSinkOpts;
  redactPaths?: readonly string[];
}

export class PinoLogger {
  private name: string;
  private transportConfigs: TransportSingleOptions[] = [];
  private fileSinkOpts: PinoFileSinkOpts | undefined;
  private redactPaths: readonly string[] | undefined;
  private activeFileSink: PinoFileSink | undefined;
  private pinoInstance: PinoLoggerInstance;
  private options: LoggerOptions;

  constructor(name: string, config: PinoLoggerConfig = {}) {
    this.name = name;
    this.options = {
      name: this.name,
      level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
      mixin: otelMixin,
      ...config.options,
    };

    if (config.transportConfigs) {
      this.transportConfigs = config.transportConfigs;
    }

    if (config.fileSink) {
      this.fileSinkOpts = config.fileSink;
    }
    if (config.redactPaths && config.redactPaths.length > 0) {
      this.redactPaths = config.redactPaths;
      this.options = {
        ...this.options,
        redact: { paths: [...config.redactPaths], censor: '[REDACTED]' },
      };
    }

    this.pinoInstance = this.buildInstance();
  }

  private resolveStreamLevels(): {
    fileLevel: string;
    consoleLevel: string;
    instanceLevel: string;
  } {
    const fileLevel = (this.options.level as string | undefined) ?? 'info';
    const envConsole = process.env.OK_CONSOLE_LEVEL?.toLowerCase();
    const consoleLevel = envConsole && VALID_LOG_LEVELS.has(envConsole) ? envConsole : fileLevel;
    return { fileLevel, consoleLevel, instanceLevel: mostVerboseLevel(fileLevel, consoleLevel) };
  }

  private buildInstance(): PinoLoggerInstance {
    this.activeFileSink = undefined;

    const { fileLevel, consoleLevel, instanceLevel } = this.resolveStreamLevels();

    if (this.transportConfigs.length > 0) {
      return pino(this.options, pino.transport({ targets: this.transportConfigs }));
    }

    let prettyStream: ReturnType<typeof pinoPretty>;
    try {
      prettyStream = pinoPretty({
        colorize: shouldColorize(),
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      });
    } catch (err) {
      console.warn('[PinoLogger] pino-pretty failed, falling back to JSON:', err);
      if (this.fileSinkOpts) {
        const fileSink = new PinoFileSink(this.fileSinkOpts);
        this.activeFileSink = fileSink;
        return pino(
          { ...this.options, level: instanceLevel },
          pino.multistream([{ stream: fileSink, level: fileLevel }]),
        );
      }
      return pino({ ...this.options, level: consoleLevel });
    }

    if (this.fileSinkOpts) {
      const fileSink = new PinoFileSink(this.fileSinkOpts);
      this.activeFileSink = fileSink;
      return pino(
        { ...this.options, level: instanceLevel },
        pino.multistream([
          { stream: prettyStream, level: consoleLevel },
          { stream: fileSink, level: fileLevel },
        ]),
      );
    }
    return pino({ ...this.options, level: consoleLevel }, prettyStream);
  }

  private recreateInstance(): void {
    if (typeof this.pinoInstance.flush === 'function') {
      this.pinoInstance.flush();
    }
    this.pinoInstance = this.buildInstance();
  }

  addTransport(transportConfig: TransportSingleOptions): void {
    this.transportConfigs.push(transportConfig);
    this.recreateInstance();
  }

  removeTransport(index: number): void {
    if (index >= 0 && index < this.transportConfigs.length) {
      this.transportConfigs.splice(index, 1);
      this.recreateInstance();
    }
  }

  getTransports(): TransportSingleOptions[] {
    return [...this.transportConfigs];
  }

  updateOptions(options: Partial<LoggerOptions>): void {
    this.options = { ...this.options, ...options };
    this.recreateInstance();
  }

  reconfigure(config: PinoLoggerConfig): void {
    if (config.options) {
      this.options = { ...this.options, ...config.options };
    }
    if (config.transportConfigs) {
      this.transportConfigs = config.transportConfigs;
    }
    if (config.fileSink) {
      this.fileSinkOpts = config.fileSink;
    }
    if (config.redactPaths && config.redactPaths.length > 0) {
      this.redactPaths = config.redactPaths;
      this.options = {
        ...this.options,
        redact: { paths: [...config.redactPaths], censor: '[REDACTED]' },
      };
    }
    this.recreateInstance();
  }

  getPinoInstance(): PinoLoggerInstance {
    return this.pinoInstance;
  }

  async flushFileSink(): Promise<void> {
    if (this.activeFileSink) {
      await this.activeFileSink.drain();
    }
  }


  error(data: unknown, message: string): void {
    this.pinoInstance.error(data, message);
  }

  warn(data: unknown, message: string): void {
    this.pinoInstance.warn(data, message);
  }

  info(data: unknown, message: string): void {
    this.pinoInstance.info(data, message);
  }

  debug(data: unknown, message: string): void {
    this.pinoInstance.debug(data, message);
  }
}

export interface LoggerFactoryConfig {
  defaultLogger?: PinoLogger;
  loggerFactory?: (name: string) => PinoLogger;
  pinoConfig?: PinoLoggerConfig;
}

class LoggerFactory {
  private config: LoggerFactoryConfig = {};
  private loggers = new Map<string, PinoLogger>();

  configure(config: LoggerFactoryConfig): void {
    this.config = config;
    if (config.pinoConfig && !config.defaultLogger && !config.loggerFactory) {
      for (const logger of this.loggers.values()) {
        logger.reconfigure(config.pinoConfig);
      }
      return;
    }
    this.loggers.clear();
  }

  getLogger(name: string): PinoLogger {
    const cached = this.loggers.get(name);
    if (cached) return cached;

    let logger: PinoLogger;
    if (this.config.loggerFactory) {
      logger = this.config.loggerFactory(name);
    } else if (this.config.defaultLogger) {
      logger = this.config.defaultLogger;
    } else {
      logger = new PinoLogger(name, this.config.pinoConfig);
    }

    this.loggers.set(name, logger);
    return logger;
  }

  reset(): void {
    this.config = {};
    this.loggers.clear();
  }

  async flushAllFileSinks(): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const logger of this.loggers.values()) {
      drains.push(logger.flushFileSink());
    }
    await Promise.all(drains);
  }
}

export const loggerFactory = new LoggerFactory();

export function getLogger(name: string): PinoLogger {
  return loggerFactory.getLogger(name);
}


export function createTestLogger(name = 'test'): PinoLogger {
  return new PinoLogger(name, { options: { level: 'silent' } });
}

export function installTestLoggers(): void {
  loggerFactory.configure({
    pinoConfig: { options: { level: 'silent' } },
  });
}
