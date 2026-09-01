export interface HttpResponseParseErrorOptions {
  cause?: unknown;
  status?: number;
  instance?: string;
}

export class HttpResponseParseError extends Error {
  readonly status?: number;
  readonly instance?: string;

  constructor(message: string, options: HttpResponseParseErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpResponseParseError';
    this.status = options.status;
    this.instance = options.instance;
  }
}
