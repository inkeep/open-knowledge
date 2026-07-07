import { context, trace } from '@opentelemetry/api';
import type { LoggerOptions, Logger as PinoLoggerInstance, TransportSingleOptions } from 'pino';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { PinoFileSink, type PinoFileSinkOpts } from './telemetry-file-sink.ts';

/**
 * Pino mixin that injects OTel trace context into log records.
 * When an active span exists, adds trace_id, span_id, and trace_flags.
 * When no span is active, returns an empty object (no trace fields).
 *
 * This enables trace↔log correlation in Grafana: clicking a log line with
 * trace_id jumps to the full trace in Tempo, and vice-versa.
 */
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

/**
 * Determines whether log output should be colorized.
 *
 * Checks in order:
 * 1. NO_COLOR env var (standard: https://no-color.org/) — if set to any non-empty value, disables colors
 * 2. Falls back to process.stdout.isTTY (colors enabled for interactive terminals)
 */
function shouldColorize(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '') {
    return false;
  }
  return process.stdout.isTTY ?? false;
}

const VALID_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** Numeric rank for level comparison; 'silent' ranks least-verbose (no output). */
function logLevelRank(level: string): number {
  if (level === 'silent') return Number.POSITIVE_INFINITY;
  return pino.levels.values[level] ?? pino.levels.values.info;
}

/** Return whichever level emits MORE records (the lower numeric pino level). */
function mostVerboseLevel(a: string, b: string): string {
  return logLevelRank(a) <= logLevelRank(b) ? a : b;
}

/**
 * Configuration options for PinoLogger
 */
export interface PinoLoggerConfig {
  /** Pino logger options (merged with defaults) */
  options?: LoggerOptions;
  /**
   * Pino transport configurations.
   *
   * NOTE: Pino transports use Node.js worker threads internally. Under Bun,
   * the default pretty-print stream (no transports) is the safe path.
   * Only add transports if you've verified they work in your runtime.
   */
  transportConfigs?: TransportSingleOptions[];
  /**
   * Optional file-destination wiring for the local diagnostics bundle. When
   * set, the logger fans out to BOTH the existing pino-pretty stdout stream
   * AND a JSON file destination via `pino.multistream`. The file
   * destination uses size-cap ring rotation; pass the resolved
   * `telemetry.localSink.logs.maxBytes` and the project root (`projectDir`,
   * where `.ok/local/logs/` lands). Omit (or pass
   * `undefined`) to preserve the pre-change single-stream pretty-stdout
   * behaviour — important for callers that haven't opted into the file
   * sink (e.g. tests, CLI tools).
   *
   * Wiring is per-instance: set on the `PinoLogger` constructor (and on
   * `loggerFactory.configure({ pinoConfig: { fileSink } })` for fan-out
   * via `getLogger`). When transports are also set, transports win
   * (they replace the default destination entirely); the file sink is
   * silently skipped.
   */
  fileSink?: PinoFileSinkOpts;
  /**
   * Pino `redact` paths applied to every log record before it reaches ANY
   * destination — stdout pretty, the file sink, and any transports. Pino
   * censors matched values with `[REDACTED]`, the same sentinel
   * `ScrubbingSpanProcessor` writes for span attributes, so credentials a
   * caller accidentally logs never land on disk regardless of whether the
   * file sink is on.
   *
   * Expected shape: dot-pathed paths matching Pino's contract — pass the
   * resolved `telemetry.localSink.attributeDenylist` plus `*.{key}`
   * wildcards (boot.ts handles this composition).
   */
  redactPaths?: readonly string[];
}

/**
 * Pino logger wrapper with pretty-printing and optional transport support.
 *
 * Default behaviour (no transports): uses pino-pretty as a direct writable
 * stream, which works in both Node.js and Bun without worker threads.
 */
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
    // Pino accepts `redact` either as a plain string[] or a {paths,censor}
    // object — we keep the array shape on the input and lift to the object
    // form inside the options merge below so callers don't have to think
    // about the censor sentinel.
    if (config.redactPaths && config.redactPaths.length > 0) {
      this.redactPaths = config.redactPaths;
      this.options = {
        ...this.options,
        redact: { paths: [...config.redactPaths], censor: '[REDACTED]' },
      };
    }

    this.pinoInstance = this.buildInstance();
  }

  /**
   * Resolve the effective per-stream levels. `fileLevel` is the configured
   * base level (what callers set via `options.level` / `LOG_LEVEL`) and
   * governs the on-disk sink. `consoleLevel` overrides the pretty stdout
   * stream from `OK_CONSOLE_LEVEL` when set to a valid level, else mirrors the
   * base. `instanceLevel` is the more-verbose of the two so the pino
   * logger-level gate (which runs before per-stream filtering) admits every
   * record either stream wants.
   *
   * This is what lets `ok start` keep the terminal legible (console raised to
   * 'warn') WITHOUT dropping the INFO diagnostics that bug-report bundles
   * depend on — those still land on the file sink at the base level.
   */
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

  /** Build or rebuild the pino instance from current config. */
  private buildInstance(): PinoLoggerInstance {
    // A prior buildInstance() may have left a PinoFileSink reference; drop
    // it so we don't keep two writers pointing at the same on-disk file
    // across rebuilds.
    this.activeFileSink = undefined;

    const { fileLevel, consoleLevel, instanceLevel } = this.resolveStreamLevels();

    if (this.transportConfigs.length > 0) {
      return pino(this.options, pino.transport({ targets: this.transportConfigs }));
    }

    // pino-pretty is the only failure mode we tolerate silently — if it throws
    // (e.g. terminal sniffing in a non-TTY environment), we fall back to
    // JSON-only stdout. PinoFileSink construction errors must NOT be swallowed:
    // silently dropping the file sink permanently disables disk logs (which
    // bug-report bundles depend on) with no user-visible signal.
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
      // JSON fallback writes to stdout only — gate it at the console level.
      return pino({ ...this.options, level: consoleLevel });
    }

    if (this.fileSinkOpts) {
      // Multistream with PER-STREAM levels: the on-disk sink keeps the base
      // level (so bug-report bundles capture INFO diagnostics) while the pretty
      // stdout stream is gated at the console level. The instance level is the
      // more-verbose of the two so neither stream is floored by the
      // logger-level gate that runs before per-stream filtering.
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
    // stdout-only (no file sink — e.g. the early `start` logger built before
    // the sink is configured) — gate purely at the console level.
    return pino({ ...this.options, level: consoleLevel }, prettyStream);
  }

  /** Recreate the pino instance (e.g. after adding/removing transports). */
  private recreateInstance(): void {
    if (typeof this.pinoInstance.flush === 'function') {
      this.pinoInstance.flush();
    }
    this.pinoInstance = this.buildInstance();
  }

  /** Add a transport and rebuild. */
  addTransport(transportConfig: TransportSingleOptions): void {
    this.transportConfigs.push(transportConfig);
    this.recreateInstance();
  }

  /** Remove a transport by index and rebuild. */
  removeTransport(index: number): void {
    if (index >= 0 && index < this.transportConfigs.length) {
      this.transportConfigs.splice(index, 1);
      this.recreateInstance();
    }
  }

  /** Get current transport configs (shallow copy). */
  getTransports(): TransportSingleOptions[] {
    return [...this.transportConfigs];
  }

  /** Merge new options and rebuild. */
  updateOptions(options: Partial<LoggerOptions>): void {
    this.options = { ...this.options, ...options };
    this.recreateInstance();
  }

  /**
   * Re-apply a `PinoLoggerConfig` to this existing instance and rebuild the
   * underlying pino instance. Used by `LoggerFactory.configure` so module-level
   * `const log = getLogger(x)` references — captured at import time, before
   * `bootServer` wires the file sink — pick up the sink + redact paths (and
   * re-read `OK_CONSOLE_LEVEL`) without the holding module re-fetching the
   * logger. Additive: only the fields present on `config` are applied, matching
   * the constructor's merge semantics.
   */
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

  /** Access the underlying pino instance for advanced usage. */
  getPinoInstance(): PinoLoggerInstance {
    return this.pinoInstance;
  }

  /**
   * Resolve once any enqueued file-sink writes have settled. No-op when no
   * file sink is wired. Useful in tests and in shutdown paths that need to
   * wait for log records to land on disk before reading the file or
   * terminating the process.
   *
   * Pino's own `.flush()` is sync and only addresses sonic-boom; the file
   * sink writes through an async `RotatingAppender` promise chain, so this
   * separate await is required to observe the on-disk state.
   */
  async flushFileSink(): Promise<void> {
    if (this.activeFileSink) {
      await this.activeFileSink.drain();
    }
  }

  // ---- Logging methods ------------------------------------------------

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

/**
 * Logger factory configuration
 */
export interface LoggerFactoryConfig {
  defaultLogger?: PinoLogger;
  loggerFactory?: (name: string) => PinoLogger;
  /** Pino config passed to auto-created PinoLogger instances */
  pinoConfig?: PinoLoggerConfig;
}

/**
 * Global logger factory singleton — caches named logger instances.
 */
class LoggerFactory {
  private config: LoggerFactoryConfig = {};
  private loggers = new Map<string, PinoLogger>();

  configure(config: LoggerFactoryConfig): void {
    this.config = config;
    // When only `pinoConfig` changes (no custom defaultLogger / loggerFactory),
    // reconfigure the already-cached PinoLoggers IN PLACE rather than clearing
    // the cache. Several modules capture `const log = getLogger(name)` at
    // module-load time — before bootServer wires the file sink — and hold that
    // reference for the process lifetime. Clearing would strand those
    // references at their pre-configure settings (no file sink, default console
    // level, so their diagnostics never reach bug-report bundles and leak onto
    // the terminal); reconfiguring in place upgrades them. The defaultLogger /
    // loggerFactory paths still clear, since they REPLACE how loggers are made.
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

  /**
   * Drain every cached PinoLogger's file sink. Called from the server's
   * shutdown sequence so log records enqueued in the final moments before
   * process.exit() land on disk — Pino's built-in .flush() is sync and only
   * addresses the sonic-boom buffer; the PinoFileSink writes through an async
   * RotatingAppender chain that must be awaited separately.
   *
   * Each PinoLogger constructed via the factory owns its own PinoFileSink
   * instance (logger.ts's buildInstance() allocates one per logger), so the
   * factory must walk every cached entry — draining any single logger does
   * not drain the others. No-op when nothing has a sink wired.
   */
  async flushAllFileSinks(): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const logger of this.loggers.values()) {
      drains.push(logger.flushFileSink());
    }
    await Promise.all(drains);
  }
}

/** Singleton factory instance */
export const loggerFactory = new LoggerFactory();

/** Convenience: get a named logger from the global factory. */
export function getLogger(name: string): PinoLogger {
  return loggerFactory.getLogger(name);
}

// ---- Test helpers --------------------------------------------------------

/** A pre-silenced logger for use in tests — no output, no env-var dependency. */
export function createTestLogger(name = 'test'): PinoLogger {
  return new PinoLogger(name, { options: { level: 'silent' } });
}

/**
 * Configure the global factory to use silent loggers for all `getLogger()` calls.
 * Call in a `beforeAll` / `beforeEach` block; pair with `loggerFactory.reset()`
 * in teardown if you need to restore production behaviour.
 */
export function installTestLoggers(): void {
  loggerFactory.configure({
    pinoConfig: { options: { level: 'silent' } },
  });
}
